//! Sync engine: drives a [`Device`] against an Anarchy server over HTTP.
//!
//! Each channel has a cursor (the last sequence number applied). Catching up
//! after being offline and receiving live updates are the same operation:
//! fetch events after the cursor and apply them in order.

use anarchy_proto::{
    AnonymousSignup, AppendRequest, AppendResponse, Blob, ChannelId, ChannelMeta, CreateChannel,
    CreateInvite, CreateSpace, DEVICE_HEADER, DeviceId, DeviceSummary, DirectoryEntry, DmStarted, EmailStart,
    EmailVerify, EventKind, EventsPage, GuestJoin, InboxItem, Invite, JoinSpace, KeyPackageUpload, Member,
    OidcLogin, OrgId, Profile, ProfileUpdate, RegisterDevice, Session, SpaceId, SpaceKind, SpaceSummary,
    StartDm, UserId,
};
use reqwest::{RequestBuilder, Response};
use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::Error;
use crate::content::{Content, Trust};
use crate::device::{Device, Incoming, PendingCommit, StoredMessage};

/// A decrypted message delivered to the application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    pub channel: ChannelId,
    pub seq: u64,
    pub sender: DeviceId,
    /// Server receive time, milliseconds since the Unix epoch.
    pub ts_ms: u64,
    pub body: Vec<u8>,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    session: Session,
    device: Device,
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
    /// Exchanges an ID token from the organisation's identity provider for a session.
    pub async fn login_with_id_token(base_url: &str, id_token: &str) -> Result<Session, Error> {
        let base = base_url.trim_end_matches('/');
        let resp = reqwest::Client::new()
            .post(format!("{base}/v1/auth/oidc"))
            .json(&OidcLogin {
                id_token: id_token.to_owned(),
            })
            .send()
            .await?;
        Ok(check(resp).await?.json().await?)
    }

    /// Joins as a guest with an invite code: no account, just a display name.
    /// Access ends when the invite expires.
    pub async fn login_as_guest(
        base_url: &str,
        invite_code: &str,
        display_name: &str,
    ) -> Result<Session, Error> {
        let base = base_url.trim_end_matches('/');
        let body = GuestJoin {
            invite_code: invite_code.to_owned(),
            display_name: display_name.to_owned(),
        };
        let resp = reqwest::Client::new()
            .post(format!("{base}/v1/auth/guest"))
            .json(&body)
            .send()
            .await?;
        Ok(check(resp).await?.json().await?)
    }

    /// Asks the server to email a one-time sign-in code to a work address.
    pub async fn request_email_code(base_url: &str, email: &str) -> Result<(), Error> {
        let base = base_url.trim_end_matches('/');
        let resp = reqwest::Client::new()
            .post(format!("{base}/v1/auth/email/start"))
            .json(&EmailStart {
                email: email.to_owned(),
            })
            .send()
            .await?;
        check(resp).await?;
        Ok(())
    }

    /// Trades an emailed one-time code for a session.
    /// Creates an anonymous account (open servers only). It can't be signed back
    /// into: the session returned is the only key to it.
    pub async fn login_anonymously(base_url: &str, display_name: Option<&str>) -> Result<Session, Error> {
        let base = base_url.trim_end_matches('/');
        let resp = reqwest::Client::new()
            .post(format!("{base}/v1/auth/anonymous"))
            .json(&AnonymousSignup {
                display_name: display_name.map(str::to_owned),
            })
            .send()
            .await?;
        Ok(check(resp).await?.json().await?)
    }

    pub async fn login_with_email_code(base_url: &str, email: &str, code: &str) -> Result<Session, Error> {
        let base = base_url.trim_end_matches('/');
        let resp = reqwest::Client::new()
            .post(format!("{base}/v1/auth/email/verify"))
            .json(&EmailVerify {
                email: email.to_owned(),
                code: code.to_owned(),
            })
            .send()
            .await?;
        Ok(check(resp).await?.json().await?)
    }

    /// Signs in with an ID token and registers `device` under that user.
    pub async fn sign_in(base_url: impl Into<String>, id_token: &str, device: Device) -> Result<Self, Error> {
        let base = base_url.into();
        let session = Self::login_with_id_token(&base, id_token).await?;
        let client = Self::from_session(base, session, device);
        client.register_device().await?;
        Ok(client)
    }

    /// Joins as a guest and registers `device` under the new guest user.
    pub async fn join_as_guest(
        base_url: impl Into<String>,
        invite_code: &str,
        display_name: &str,
        device: Device,
    ) -> Result<Self, Error> {
        let base = base_url.into();
        let session = Self::login_as_guest(&base, invite_code, display_name).await?;
        let client = Self::from_session(base, session, device);
        client.register_device().await?;
        Ok(client)
    }

    /// Resumes a session saved earlier (for example after an app restart), without a network call.
    pub fn from_session(base_url: impl Into<String>, session: Session, device: Device) -> Self {
        let base = base_url.into().trim_end_matches('/').to_owned();
        Self {
            http: reqwest::Client::new(),
            base,
            session,
            device,
        }
    }

    /// Registers this client's device under the session's user. Safe to repeat.
    pub async fn register_device(&self) -> Result<(), Error> {
        Self::register(
            &self.base,
            &self.session,
            self.device.id(),
            self.device.signature_public_key(),
        )
        .await
    }

    /// Registers a device without borrowing it across the request, for callers
    /// (like the desktop app) whose futures must be `Send`: `Device` isn't `Sync`.
    pub async fn register(
        base_url: &str,
        session: &Session,
        device_id: DeviceId,
        signature_key: Vec<u8>,
    ) -> Result<(), Error> {
        let register = RegisterDevice {
            device_id,
            signature_key: Blob(signature_key),
        };
        check(
            reqwest::Client::new()
                .post(format!("{}/v1/devices", base_url.trim_end_matches('/')))
                .bearer_auth(&session.token)
                .json(&register)
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn server_url(&self) -> &str {
        &self.base
    }

    /// Signs out locally: gives the device back. Its keys and channels stay on disk.
    pub fn into_device(self) -> Device {
        self.device
    }

    /// Creates a guest invite code (members only). The code is shown once.
    pub async fn create_invite(
        &self,
        expires_in: std::time::Duration,
        max_uses: u32,
    ) -> Result<Invite, Error> {
        let body = CreateInvite {
            expires_in_secs: expires_in.as_secs(),
            max_uses,
        };
        Ok(self.post("/v1/invites", &body).await?.json().await?)
    }

    pub async fn revoke_invite(&self, invite: uuid::Uuid) -> Result<(), Error> {
        self.post(&format!("/v1/invites/{invite}/revoke"), &()).await?;
        Ok(())
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

    /// Last sequence number applied in `channel`, stored in the device database.
    pub fn cursor(&self, channel: ChannelId) -> Result<u64, Error> {
        self.device.cursor(channel)
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

    async fn put<B: serde::Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T, Error> {
        let req = self
            .authed(self.http.put(format!("{}{path}", self.base)))
            .json(body);
        Ok(check(req.send().await?).await?.json().await?)
    }

    // ---------- profile, spaces, direct conversations ----------

    pub async fn me(&self) -> Result<Profile, Error> {
        self.get("/v1/me", &[]).await
    }

    pub async fn update_me(&self, update: &ProfileUpdate) -> Result<Profile, Error> {
        self.put("/v1/me", update).await
    }

    pub async fn spaces(&self) -> Result<Vec<SpaceSummary>, Error> {
        self.get("/v1/spaces", &[]).await
    }

    pub async fn create_space(&self, name: &str, kind: SpaceKind) -> Result<SpaceSummary, Error> {
        let body = CreateSpace {
            name: name.to_owned(),
            kind,
        };
        Ok(self.post("/v1/spaces", &body).await?.json().await?)
    }

    pub async fn create_space_invite(
        &self,
        space: SpaceId,
        expires_in: std::time::Duration,
        max_uses: u32,
    ) -> Result<Invite, Error> {
        let body = CreateInvite {
            expires_in_secs: expires_in.as_secs(),
            max_uses,
        };
        Ok(self
            .post(&format!("/v1/spaces/{space}/invites"), &body)
            .await?
            .json()
            .await?)
    }

    pub async fn join_space(&self, invite_code: &str) -> Result<SpaceSummary, Error> {
        let body = JoinSpace {
            invite_code: invite_code.to_owned(),
        };
        Ok(self.post("/v1/spaces/join", &body).await?.json().await?)
    }

    /// Server-side facts about this device's channels: space, or the DM peer.
    pub async fn channel_metas(&self) -> Result<Vec<ChannelMeta>, Error> {
        self.get("/v1/channels", &[]).await
    }

    /// People in one space (who share it with you).
    pub async fn directory_in(&self, space: SpaceId) -> Result<Vec<DirectoryEntry>, Error> {
        let req = self
            .authed(self.http.get(format!("{}/v1/directory", self.base)))
            .query(&[("space", space.to_string())]);
        Ok(check(req.send().await?).await?.json().await?)
    }

    /// Opens a direct conversation with `username#tag`, or returns the existing
    /// one. Returns the channel, the other person, and their devices that couldn't
    /// be added yet (no key package).
    pub async fn start_dm(
        &mut self,
        username: &str,
        tag: u16,
    ) -> Result<(ChannelId, DirectoryEntry, Vec<DeviceId>), Error> {
        let channel = Uuid::new_v4();
        self.device.create_channel(channel)?;
        let started: Result<DmStarted, Error> = async {
            let body = StartDm {
                username: username.to_owned(),
                tag,
                channel,
            };
            Ok(self.post("/v1/dms", &body).await?.json().await?)
        }
        .await;
        let started = match started {
            Ok(s) => s,
            Err(e) => {
                self.device.forget_channel(channel)?;
                return Err(e);
            }
        };
        if !started.created {
            self.device.forget_channel(channel)?;
            return Ok((started.channel, started.peer, Vec::new()));
        }
        let skipped = self.add_person(channel, &started.peer).await?;
        Ok((channel, started.peer, skipped))
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
    /// Creates a channel in the default space (company servers).
    pub async fn create_channel(&mut self) -> Result<ChannelId, Error> {
        self.create_channel_in(None).await
    }

    pub async fn create_channel_in(&mut self, space: Option<SpaceId>) -> Result<ChannelId, Error> {
        let channel = Uuid::new_v4();
        self.post("/v1/channels", &CreateChannel { channel, space })
            .await?;
        self.device.create_channel(channel)?;
        Ok(channel)
    }

    /// People in the organisation and their devices (members only; guests get 403).
    pub async fn directory(&self) -> Result<Vec<DirectoryEntry>, Error> {
        self.get("/v1/directory", &[]).await
    }

    /// This user's devices, including revoked ones.
    pub async fn my_devices(&self) -> Result<Vec<DeviceSummary>, Error> {
        self.get("/v1/devices", &[]).await
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
        let welcome = pending
            .welcome
            .clone()
            .expect("add_member always produces a Welcome");
        self.commit(pending, vec![device], vec![]).await?;
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

    /// Removes devices from a channel. The commit rotates the channel's keys, so
    /// they can't read anything sent afterwards, and the server stops serving
    /// them the channel after that commit.
    pub async fn remove_devices(&mut self, channel: ChannelId, devices: &[DeviceId]) -> Result<(), Error> {
        self.sync(channel).await?;
        let pending = self.device.remove_members(channel, devices)?;
        self.commit(pending, vec![], devices.to_vec()).await
    }

    /// Removes every device of `user` from a channel.
    pub async fn remove_user(&mut self, channel: ChannelId, user: UserId) -> Result<(), Error> {
        let devices: Vec<DeviceId> = self
            .members(channel)
            .await?
            .into_iter()
            .filter(|m| m.user_id == user)
            .map(|m| m.device_id)
            .collect();
        if devices.is_empty() {
            return Ok(());
        }
        self.remove_devices(channel, &devices).await
    }

    /// Removes devices that are still in the channel's MLS group but that the
    /// server no longer lists (revoked, e.g. a lost laptop). Any member can run
    /// this; if two do at once, one wins and the other finds nothing left to do.
    /// Returns the devices removed.
    pub async fn remove_revoked(&mut self, channel: ChannelId) -> Result<Vec<DeviceId>, Error> {
        self.sync(channel).await?;
        let listed: Vec<DeviceId> = self
            .members(channel)
            .await?
            .into_iter()
            .map(|m| m.device_id)
            .collect();
        let stale: Vec<DeviceId> = self
            .device
            .member_devices(channel)?
            .into_iter()
            .filter(|d| !listed.contains(d))
            .collect();
        if stale.is_empty() {
            return Ok(stale);
        }
        let pending = self.device.remove_members(channel, &stale)?;
        self.commit(pending, vec![], stale.clone()).await?;
        Ok(stale)
    }

    /// Revokes one of this user's devices (lost or retired). It can no longer
    /// authenticate; members then remove it from channels with [`Client::remove_revoked`].
    pub async fn revoke_device(&self, device: DeviceId) -> Result<(), Error> {
        self.post(&format!("/v1/devices/{device}/revoke"), &()).await?;
        Ok(())
    }

    /// Posts a staged commit and applies it locally if the server accepts it.
    async fn commit(
        &mut self,
        pending: PendingCommit,
        adds: Vec<DeviceId>,
        removes: Vec<DeviceId>,
    ) -> Result<(), Error> {
        let channel = pending.channel;
        let req = AppendRequest {
            epoch: pending.epoch,
            kind: EventKind::Commit,
            idempotency_key: Uuid::new_v4(),
            payload: Blob(pending.commit),
            adds,
            removes,
        };
        match self.post(&format!("/v1/channels/{channel}/events"), &req).await {
            Ok(resp) => match resp.json().await? {
                AppendResponse::Accepted { seq } => {
                    self.device.confirm_commit(channel)?;
                    // Our own commit is already applied; don't process it again on sync.
                    self.device.set_cursor(channel, seq)
                }
                AppendResponse::StaleEpoch { current_epoch } => {
                    self.device.discard_commit(channel)?;
                    Err(Error::StaleEpoch {
                        channel,
                        current_epoch,
                    })
                }
            },
            Err(e) => {
                self.device.discard_commit(channel)?;
                Err(e)
            }
        }
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
            removes: vec![],
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

    /// Creates a channel and sets its (encrypted) name, topic and trust state.
    pub async fn create_named_channel(
        &mut self,
        name: &str,
        topic: &str,
        trust: Trust,
    ) -> Result<ChannelId, Error> {
        self.create_named_channel_in(None, name, topic, trust).await
    }

    pub async fn create_named_channel_in(
        &mut self,
        space: Option<SpaceId>,
        name: &str,
        topic: &str,
        trust: Trust,
    ) -> Result<ChannelId, Error> {
        let channel = self.create_channel_in(space).await?;
        let info = Content::ChannelInfo {
            name: name.to_owned(),
            topic: topic.to_owned(),
            trust,
            desk: None,
        };
        self.send_content(channel, &info).await?;
        Ok(channel)
    }

    /// Sends a message and keeps it in local history (MLS can't decrypt our own messages later).
    pub async fn send_content(&mut self, channel: ChannelId, content: &Content) -> Result<u64, Error> {
        let bytes = content.encode();
        let seq = self.send(channel, &bytes).await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64);
        self.device.store_message(
            channel,
            &StoredMessage {
                seq,
                sender: self.device.id(),
                ts_ms: now.unwrap_or(0),
                content: bytes,
            },
        )?;
        Ok(seq)
    }

    /// Syncs a channel and keeps what arrived in local history.
    pub async fn sync_and_store(&mut self, channel: ChannelId) -> Result<Vec<Delivered>, Error> {
        let delivered = self.sync(channel).await?;
        if self.device.has_channel(channel) {
            for m in &delivered {
                self.device.store_message(
                    channel,
                    &StoredMessage {
                        seq: m.seq,
                        sender: m.sender,
                        ts_ms: m.ts_ms,
                        content: m.body.clone(),
                    },
                )?;
            }
        }
        Ok(delivered)
    }

    /// The channel's latest name, topic and trust state, from local history.
    pub fn channel_info(&self, channel: ChannelId) -> Result<Option<(String, String, Trust)>, Error> {
        Ok(self.channel_info_full(channel)?.and_then(|c| match c {
            Content::ChannelInfo {
                name, topic, trust, ..
            } => Some((name, topic, trust)),
            _ => None,
        }))
    }

    /// The latest channel info message, desk kind included.
    pub fn channel_info_full(&self, channel: ChannelId) -> Result<Option<Content>, Error> {
        let history = self.device.messages(channel, u32::MAX)?;
        Ok(history
            .iter()
            .rev()
            .map(|m| Content::decode(&m.content))
            .find(|c| matches!(c, Content::ChannelInfo { .. })))
    }

    /// The desk kind, if this channel is a desk.
    pub fn desk_kind(&self, channel: ChannelId) -> Result<Option<String>, Error> {
        Ok(match self.channel_info_full(channel)? {
            Some(Content::ChannelInfo { desk, .. }) => desk,
            _ => None,
        })
    }

    /// A desk's records as they stand now.
    pub fn desk_items(&self, channel: ChannelId) -> Result<Vec<crate::DeskItem>, Error> {
        let history = self.device.messages(channel, u32::MAX)?;
        Ok(crate::fold_items(
            history.iter().map(|m| (m.seq, m.ts_ms, m.content.as_slice())),
        ))
    }

    // ---------- files ----------

    async fn upload_blob(&self, channel: ChannelId, bytes: Vec<u8>) -> Result<Uuid, Error> {
        let req = self
            .authed(
                self.http
                    .post(format!("{}/v1/channels/{channel}/blobs", self.base)),
            )
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes);
        let r: anarchy_proto::BlobRef = check(req.send().await?).await?.json().await?;
        Ok(r.id)
    }

    async fn download_blob(&self, channel: ChannelId, blob: Uuid) -> Result<Vec<u8>, Error> {
        let req = self.authed(
            self.http
                .get(format!("{}/v1/channels/{channel}/blobs/{blob}", self.base)),
        );
        Ok(check(req.send().await?).await?.bytes().await?.to_vec())
    }

    /// Encrypts a file, uploads its chunks, and returns the record data to store
    /// in the drive (with `name`, `folder` and `mime` alongside). Nothing is
    /// announced to the channel yet; the caller writes the record.
    pub async fn upload_file(&self, channel: ChannelId, bytes: &[u8]) -> Result<serde_json::Value, Error> {
        let (key, chunks) = crate::files::seal(bytes)?;
        let mut ids = Vec::with_capacity(chunks.len());
        for c in chunks {
            ids.push(self.upload_blob(channel, c).await?.to_string());
        }
        Ok(serde_json::json!({ "file_key": key, "chunks": ids }))
    }

    /// Downloads and decrypts a file from its record data.
    pub async fn download_file(
        &self,
        channel: ChannelId,
        data: &serde_json::Value,
    ) -> Result<Vec<u8>, Error> {
        let key: crate::files::FileKey = serde_json::from_value(data["file_key"].clone())
            .map_err(|_| Error::Storage("this record has no file".into()))?;
        let ids: Vec<Uuid> = serde_json::from_value(data["chunks"].clone())
            .map_err(|_| Error::Storage("this record has no file".into()))?;
        let mut chunks = Vec::with_capacity(ids.len());
        for id in ids {
            chunks.push(self.download_blob(channel, id).await?);
        }
        crate::files::open(&key, &chunks)
    }

    // ---------- pay links ----------

    /// Seals `page` (what the client sees) and publishes it. Returns the link id
    /// and the full URL, whose `#fragment` is the only copy of the key outside
    /// this device; keep it in the desk record so members can copy it again.
    pub async fn create_pay_link(
        &self,
        channel: ChannelId,
        page: &serde_json::Value,
        expires_at_ms: u64,
    ) -> Result<(String, String), Error> {
        let (sealed, key) = crate::links::seal(page)?;
        let created: anarchy_proto::PayLinkCreated = self
            .post(
                &format!("/v1/channels/{channel}/pay_links"),
                &anarchy_proto::CreatePayLink {
                    sealed,
                    expires_at_ms,
                },
            )
            .await?
            .json()
            .await?;
        let url = format!("{}/p/{}#{key}", self.base, created.id);
        Ok((created.id, url))
    }

    /// Replaces a link's content, keeping its address and key (taken from `url`).
    pub async fn update_pay_link(
        &self,
        channel: ChannelId,
        url: &str,
        page: &serde_json::Value,
    ) -> Result<(), Error> {
        let (id, key) = crate::links::parse_url(url)?;
        let sealed = crate::links::seal_with(page, &key)?;
        let req = self
            .authed(
                self.http
                    .put(format!("{}/v1/channels/{channel}/pay_links/{id}", self.base)),
            )
            .json(&anarchy_proto::UpdatePayLink { sealed });
        check(req.send().await?).await?;
        Ok(())
    }

    pub async fn pay_links(&self, channel: ChannelId) -> Result<Vec<anarchy_proto::PayLinkStatus>, Error> {
        self.get(&format!("/v1/channels/{channel}/pay_links"), &[]).await
    }

    pub async fn revoke_pay_link(&self, channel: ChannelId, id: &str) -> Result<(), Error> {
        self.post(&format!("/v1/channels/{channel}/pay_links/{id}/revoke"), &())
            .await?;
        Ok(())
    }

    /// Creates a desk: a channel in `space` whose info names the desk kind.
    pub async fn create_desk(
        &mut self,
        space: Option<SpaceId>,
        name: &str,
        kind: &str,
    ) -> Result<ChannelId, Error> {
        let channel = self.create_channel_in(space).await?;
        let info = Content::ChannelInfo {
            name: name.to_owned(),
            topic: String::new(),
            trust: Trust::Company,
            desk: Some(kind.to_owned()),
        };
        self.send_content(channel, &info).await?;
        Ok(channel)
    }

    /// Adds every active device of a person to a channel. Devices without key
    /// packages are skipped and returned, so the caller can say who couldn't be added yet.
    pub async fn add_user(&mut self, channel: ChannelId, user: UserId) -> Result<Vec<DeviceId>, Error> {
        let person = self
            .directory()
            .await?
            .into_iter()
            .find(|p| p.user_id == user)
            .ok_or_else(|| Error::Api {
                status: 404,
                message: "no such person".into(),
            })?;
        self.add_person(channel, &person).await
    }

    /// Adds every active device of `person`; returns those without a key package.
    async fn add_person(
        &mut self,
        channel: ChannelId,
        person: &DirectoryEntry,
    ) -> Result<Vec<DeviceId>, Error> {
        let already: Vec<DeviceId> = self.device.member_devices(channel)?;
        let mut skipped = Vec::new();
        let mut added = 0;
        for &device in person.devices.iter().filter(|d| !already.contains(d)) {
            match self.add_device(channel, device).await {
                Ok(()) => added += 1,
                Err(Error::NoKeyPackage(d)) => skipped.push(d),
                Err(e) => return Err(e),
            }
        }
        // Newcomers can't read anything from before they joined, the channel's name
        // and a desk's records included, so say them again in the new epoch.
        if added > 0 {
            if let Some(info) = self.channel_info_full(channel)? {
                self.send_content(channel, &info).await?;
            }
            let items: Vec<crate::ItemRecord> = self
                .desk_items(channel)?
                .into_iter()
                .map(|i| crate::ItemRecord {
                    id: i.id,
                    kind: i.kind,
                    data: i.data,
                })
                .collect();
            if !items.is_empty() {
                self.send_content(channel, &Content::Items { items }).await?;
            }
        }
        Ok(skipped)
    }

    /// Fetches every event after the cursor, applies them in order and returns the new messages.
    ///
    /// If one of the events removes this device, the channel is deleted locally
    /// and sync stops there: afterwards `device().has_channel(channel)` is false.
    pub async fn sync(&mut self, channel: ChannelId) -> Result<Vec<Delivered>, Error> {
        let mut delivered = Vec::new();
        loop {
            let after = self.cursor(channel)?;
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
                if !own && !before_join {
                    match self.device.receive(channel, &event.payload.0)? {
                        Incoming::Message(body) => delivered.push(Delivered {
                            channel,
                            seq: event.seq,
                            sender: event.sender_device,
                            ts_ms: event.ts_ms,
                            body,
                        }),
                        Incoming::EpochAdvanced => {}
                        Incoming::Removed => return Ok(delivered),
                    }
                }
                self.device.set_cursor(channel, event.seq)?;
            }
            if last >= page.head {
                break;
            }
        }
        Ok(delivered)
    }
}
