//! Sync engine: drives a [`Device`] against an Anarchy server over HTTP.
//!
//! Each channel has a cursor (the last sequence number applied). Catching up
//! after being offline and receiving live updates are the same operation:
//! fetch events after the cursor and apply them in order.

use std::collections::HashMap;

use anarchy_proto::{
    AppendRequest, AppendResponse, Blob, ChannelId, CreateChannel, DEVICE_HEADER, DeviceId, EventKind,
    EventsPage, InboxItem, KeyPackageUpload, Member, OidcLogin, OrgId, RegisterDevice, Session, UserId,
};
use reqwest::{RequestBuilder, Response};
use serde::de::DeserializeOwned;
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
    session: Session,
    device: Device,
    cursors: HashMap<ChannelId, u64>,
}

/// Turns non-2xx responses into [`Error::Api`] with the server's message.
async fn check(resp: Response) -> Result<Response, Error> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let message = resp
        .json::<anarchy_proto::ApiError>()
        .await
        .map(|e| e.error)
        .unwrap_or_else(|_| status.to_string());
    Err(Error::Api {
        status: status.as_u16(),
        message,
    })
}

impl Client {
    /// Signs in with an ID token from the organisation's identity provider and
    /// registers `device` under that user.
    pub async fn sign_in(base_url: impl Into<String>, id_token: &str, device: Device) -> Result<Self, Error> {
        let http = reqwest::Client::new();
        let base = base_url.into().trim_end_matches('/').to_owned();
        let resp = http
            .post(format!("{base}/v1/auth/oidc"))
            .json(&OidcLogin {
                id_token: id_token.to_owned(),
            })
            .send()
            .await?;
        let session: Session = check(resp).await?.json().await?;
        let client = Self {
            http,
            base,
            session,
            device,
            cursors: HashMap::new(),
        };
        let register = RegisterDevice {
            device_id: client.device.id(),
            signature_key: Blob(client.device.signature_public_key()),
        };
        check(
            client
                .http
                .post(format!("{}/v1/devices", client.base))
                .bearer_auth(&client.session.token)
                .json(&register)
                .send()
                .await?,
        )
        .await?;
        Ok(client)
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    pub fn user_id(&self) -> UserId {
        self.session.user_id
    }

    pub fn org_id(&self) -> OrgId {
        self.session.org_id
    }

    /// The session bearer token, for API calls this client doesn't wrap yet.
    pub fn session_token(&self) -> &str {
        &self.session.token
    }

    pub fn cursor(&self, channel: ChannelId) -> u64 {
        self.cursors.get(&channel).copied().unwrap_or(0)
    }

    /// Restores a cursor saved by the application (for example after a restart).
    pub fn set_cursor(&mut self, channel: ChannelId, seq: u64) {
        self.cursors.insert(channel, seq);
    }

    fn authed(&self, req: RequestBuilder) -> RequestBuilder {
        req.bearer_auth(&self.session.token)
            .header(DEVICE_HEADER, self.device.id().to_string())
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, u64)]) -> Result<T, Error> {
        let req = self
            .authed(self.http.get(format!("{}{path}", self.base)))
            .query(query);
        Ok(check(req.send().await?).await?.json().await?)
    }

    async fn post<B: serde::Serialize>(&self, path: &str, body: &B) -> Result<Response, Error> {
        let req = self
            .authed(self.http.post(format!("{}{path}", self.base)))
            .json(body);
        check(req.send().await?).await
    }

    pub async fn publish_key_packages(&self, count: usize) -> Result<(), Error> {
        let body = KeyPackageUpload {
            key_packages: self.device.key_packages(count)?.into_iter().map(Blob).collect(),
        };
        self.post(&format!("/v1/devices/{}/key_packages", self.device.id()), &body)
            .await?;
        Ok(())
    }

    /// Creates a channel on the server and its MLS group on this device.
    pub async fn create_channel(&mut self) -> Result<ChannelId, Error> {
        let channel = Uuid::new_v4();
        self.post("/v1/channels", &CreateChannel { channel }).await?;
        self.device.create_channel(channel)?;
        Ok(channel)
    }

    pub async fn members(&self, channel: ChannelId) -> Result<Vec<Member>, Error> {
        self.get(&format!("/v1/channels/{channel}/members"), &[]).await
    }

    /// Adds another device to a channel: claims one of its key packages, posts
    /// the commit, and delivers the Welcome to its inbox.
    pub async fn add_device(&mut self, channel: ChannelId, device: DeviceId) -> Result<(), Error> {
        self.sync(channel).await?;
        let key_package: Blob = match self
            .post(&format!("/v1/devices/{device}/key_packages/claim"), &())
            .await
        {
            Ok(resp) => resp.json().await?,
            Err(Error::Api { status: 404, .. }) => return Err(Error::NoKeyPackage(device)),
            Err(e) => return Err(e),
        };

        let pending = self.device.add_member(channel, &key_package.0)?;
        let req = AppendRequest {
            epoch: pending.epoch,
            kind: EventKind::Commit,
            idempotency_key: Uuid::new_v4(),
            payload: Blob(pending.commit),
            adds: vec![device],
        };
        match self.post(&format!("/v1/channels/{channel}/events"), &req).await {
            Ok(resp) => match resp.json().await? {
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
            },
            Err(e) => {
                self.device.discard_commit(channel)?;
                return Err(e);
            }
        }
        let welcome = pending.welcome.expect("add_member always produces a Welcome");
        self.post(
            &format!("/v1/devices/{device}/inbox"),
            &InboxItem {
                channel,
                welcome: Blob(welcome),
            },
        )
        .await?;
        Ok(())
    }

    /// Joins every channel this device was added to since the last call.
    pub async fn accept_invites(&mut self) -> Result<Vec<ChannelId>, Error> {
        let items: Vec<InboxItem> = self
            .get(&format!("/v1/devices/{}/inbox", self.device.id()), &[])
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
        let req = AppendRequest {
            epoch,
            kind: EventKind::Application,
            idempotency_key: Uuid::new_v4(),
            payload: Blob(ciphertext),
            adds: vec![],
        };
        match self
            .post(&format!("/v1/channels/{channel}/events"), &req)
            .await?
            .json()
            .await?
        {
            AppendResponse::Accepted { seq } => Ok(seq),
            AppendResponse::StaleEpoch { current_epoch } => Err(Error::StaleEpoch {
                channel,
                current_epoch,
            }),
        }
    }

    /// Fetches every event after the cursor, applies them in order and returns the new messages.
    pub async fn sync(&mut self, channel: ChannelId) -> Result<Vec<Delivered>, Error> {
        let mut delivered = Vec::new();
        loop {
            let after = self.cursor(channel);
            let page: EventsPage = self
                .get(&format!("/v1/channels/{channel}/events"), &[("after", after)])
                .await?;
            let Some(last) = page.events.last().map(|e| e.seq) else {
                break;
            };
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
            if last >= page.head {
                break;
            }
        }
        Ok(delivered)
    }
}
