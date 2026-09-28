//! Wire types shared by Anarchy clients and servers.
//!
//! The server only ever sees these envelopes. `payload` is always an opaque MLS
//! message: a commit or an encrypted application message. The server orders
//! events per channel and checks epochs; it never decrypts.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

pub type ChannelId = Uuid;
pub type DeviceId = Uuid;

/// What kind of MLS message an event carries. The server needs this to track
/// the channel's epoch: a commit moves the epoch forward, nothing else does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Commit,
    Application,
}

/// Opaque bytes, base64 in JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blob(pub Vec<u8>);

impl Serialize for Blob {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&B64.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Blob {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        B64.decode(s).map(Blob).map_err(serde::de::Error::custom)
    }
}

pub type UserId = Uuid;
pub type OrgId = Uuid;

/// Header naming the device a request acts for. It must belong to the session's user.
pub const DEVICE_HEADER: &str = "x-anarchy-device";

/// `POST /v1/auth/oidc`: exchange an ID token from the org's identity provider for a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcLogin {
    pub id_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// Bearer token for `Authorization: Bearer …`. The server stores only its hash.
    pub token: String,
    pub user_id: UserId,
    pub org_id: OrgId,
    pub expires_at_ms: u64,
    /// Guests joined with an invite code; their session ends when the invite does.
    #[serde(default)]
    pub is_guest: bool,
}

/// `GET /v1/auth/config` (public): what a client needs before anyone signs in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthConfig {
    pub org_name: String,
    /// OpenID Connect issuer; clients discover its endpoints from it.
    pub issuer: String,
    /// The public client ID registered for Anarchy at the identity provider.
    pub client_id: String,
    /// Whether people can join with an invite code instead of an account.
    pub guests_enabled: bool,
}

/// `POST /v1/auth/guest`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestJoin {
    pub invite_code: String,
    /// Shown to others instead of a real name. 1–64 characters.
    pub display_name: String,
}

/// `POST /v1/invites`: members (not guests) create guest invites.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvite {
    pub expires_in_secs: u64,
    pub max_uses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    pub id: Uuid,
    /// Shown once. The server keeps only its hash.
    pub code: String,
    pub expires_at_ms: u64,
    pub max_uses: u32,
}

/// Normalises a typed invite code: case, spaces and dashes don't matter.
pub fn normalize_invite_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// `POST /v1/devices`: register a device under the signed-in user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDevice {
    pub device_id: DeviceId,
    /// The device's MLS signature public key (Ed25519).
    pub signature_key: Blob,
}

/// `POST /v1/channels`: register a new channel; the calling device becomes its first member.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateChannel {
    pub channel: ChannelId,
}

/// `GET /v1/channels/{channel}/members`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub device_id: DeviceId,
    pub user_id: UserId,
}

/// `POST /v1/channels/{channel}/events`. The sender is the authenticated device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendRequest {
    /// The MLS epoch the sender was in when producing `payload`.
    pub epoch: u64,
    pub kind: EventKind,
    /// Retries with the same key return the original sequence number.
    pub idempotency_key: Uuid,
    pub payload: Blob,
    /// Devices this commit adds. The server can't read the commit, so it trusts this
    /// list for routing access only; MLS still decides who can decrypt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adds: Vec<DeviceId>,
    /// Devices this commit removes. Same trust model as `adds`: a member who lies
    /// here can lock a device out of the server, but can't grant anyone access.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removes: Vec<DeviceId>,
}

/// Error body for every non-2xx response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AppendResponse {
    Accepted {
        seq: u64,
    },
    /// The sender is behind: it must fetch and apply the missing commits, then retry.
    StaleEpoch {
        current_epoch: u64,
    },
}

/// One entry in a channel's ordered log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub epoch: u64,
    pub kind: EventKind,
    pub sender_device: DeviceId,
    /// Server receive time, milliseconds since the Unix epoch.
    pub ts_ms: u64,
    pub payload: Blob,
}

/// `GET /v1/channels/{channel}/events?after={seq}` returns events with `seq > after`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventsPage {
    pub events: Vec<Event>,
    /// Highest sequence number in the channel, for cursors.
    pub head: u64,
}

/// `POST /v1/devices/{device}/key_packages`: MLS key packages others use to add this device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPackageUpload {
    pub key_packages: Vec<Blob>,
}

/// `POST /v1/devices/{device}/inbox`: a Welcome for a device that was just added to a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxItem {
    pub channel: ChannelId,
    pub welcome: Blob,
}
