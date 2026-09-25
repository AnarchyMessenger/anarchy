//! Sync engine: drives a [`Device`] against an Anarchy server over HTTP.
//!
//! Each channel has a cursor (the last sequence number applied). Catching up
//! after being offline and receiving live updates are the same operation:
//! fetch events after the cursor and apply them in order.

use std::collections::HashMap;

use anarchy_proto::{
    AppendRequest, AppendResponse, Blob, ChannelId, DeviceId, EventKind, EventsPage, InboxItem,
    KeyPackageUpload,
};
use uuid::Uuid;

use crate::Error;
use crate::device::{Device, Incoming};

/// A decrypted message delivered to the application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    pub channel: ChannelId,
    pub seq: u64,
    pub sender: DeviceId,
    pub body: Vec<u8>,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    device: Device,
    cursors: HashMap<ChannelId, u64>,
}

impl Client {
    pub fn new(base_url: impl Into<String>, device: Device) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: base_url.into().trim_end_matches('/').to_owned(),
            device,
            cursors: HashMap::new(),
        }
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    pub fn cursor(&self, channel: ChannelId) -> u64 {
        self.cursors.get(&channel).copied().unwrap_or(0)
    }

    pub async fn publish_key_packages(&self, count: usize) -> Result<(), Error> {
        let body = KeyPackageUpload {
            key_packages: self.device.key_packages(count)?.into_iter().map(Blob).collect(),
        };
        self.http
            .post(format!(
                "{}/v1/devices/{}/key_packages",
                self.base,
                self.device.id()
            ))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub fn create_channel(&mut self) -> Result<ChannelId, Error> {
        let channel = Uuid::new_v4();
        self.device.create_channel(channel)?;
        Ok(channel)
    }

    /// Adds another device to a channel: claims one of its key packages, posts
    /// the commit, and delivers the Welcome to its inbox.
    pub async fn add_device(&mut self, channel: ChannelId, device: DeviceId) -> Result<(), Error> {
        self.sync(channel).await?;
        let resp = self
            .http
            .post(format!("{}/v1/devices/{device}/key_packages/claim", self.base))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Error::NoKeyPackage(device));
        }
        let key_package: Blob = resp.error_for_status()?.json().await?;

        let pending = self.device.add_member(channel, &key_package.0)?;
        match self
            .append(channel, pending.epoch, EventKind::Commit, pending.commit)
            .await?
        {
            AppendResponse::Accepted { seq } => {
                self.device.confirm_commit(channel)?;
                // Our own commit is already applied; don't process it again on sync.
                self.cursors.insert(channel, seq);
            }
            AppendResponse::StaleEpoch { current_epoch } => {
                self.device.discard_commit(channel)?;
                return Err(Error::StaleEpoch {
                    channel,
                    current_epoch,
                });
            }
        }
        let welcome = pending.welcome.expect("add_member always produces a Welcome");
        self.http
            .post(format!("{}/v1/devices/{device}/inbox", self.base))
            .json(&InboxItem {
                channel,
                welcome: Blob(welcome),
            })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Joins every channel this device was added to since the last call.
    pub async fn accept_invites(&mut self) -> Result<Vec<ChannelId>, Error> {
        let items: Vec<InboxItem> = self
            .http
            .get(format!("{}/v1/devices/{}/inbox", self.base, self.device.id()))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let mut joined = Vec::with_capacity(items.len());
        for item in items {
            let channel = self.device.join(&item.welcome.0)?;
            if channel != item.channel {
                return Err(Error::Mls(
                    "Welcome does not match the channel it was sent for".into(),
                ));
            }
            joined.push(channel);
        }
        Ok(joined)
    }

    /// Encrypts and posts a message. Returns its sequence number.
    pub async fn send(&mut self, channel: ChannelId, body: &[u8]) -> Result<u64, Error> {
        let (epoch, ciphertext) = self.device.encrypt(channel, body)?;
        match self
            .append(channel, epoch, EventKind::Application, ciphertext)
            .await?
        {
            AppendResponse::Accepted { seq } => Ok(seq),
            AppendResponse::StaleEpoch { current_epoch } => Err(Error::StaleEpoch {
                channel,
                current_epoch,
            }),
        }
    }

    /// Fetches events after the cursor, applies them in order and returns the new messages.
    pub async fn sync(&mut self, channel: ChannelId) -> Result<Vec<Delivered>, Error> {
        let after = self.cursor(channel);
        let page: EventsPage = self
            .http
            .get(format!("{}/v1/channels/{channel}/events", self.base))
            .query(&[("after", after)])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut delivered = Vec::new();
        for event in page.events {
            // Skip our own events (MLS can't decrypt a sender's own application
            // messages, and our commits were applied when the server accepted
            // them) and events from before we joined.
            let own = event.sender_device == self.device.id();
            let before_join = event.epoch < self.device.epoch(channel)?;
            if !own
                && !before_join
                && let Incoming::Message(body) = self.device.receive(channel, &event.payload.0)?
            {
                delivered.push(Delivered {
                    channel,
                    seq: event.seq,
                    sender: event.sender_device,
                    body,
                });
            }
            self.cursors.insert(channel, event.seq);
        }
        Ok(delivered)
    }

    async fn append(
        &self,
        channel: ChannelId,
        epoch: u64,
        kind: EventKind,
        payload: Vec<u8>,
    ) -> Result<AppendResponse, Error> {
        let req = AppendRequest {
            sender_device: self.device.id(),
            epoch,
            kind,
            idempotency_key: Uuid::new_v4(),
            payload: Blob(payload),
        };
        Ok(self
            .http
            .post(format!("{}/v1/channels/{channel}/events", self.base))
            .json(&req)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
}
