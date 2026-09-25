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

/// `POST /v1/channels/{channel}/events`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendRequest {
    pub sender_device: DeviceId,
    /// The MLS epoch the sender was in when producing `payload`.
    pub epoch: u64,
    pub kind: EventKind,
    /// Retries with the same key return the original sequence number.
    pub idempotency_key: Uuid,
    pub payload: Blob,
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
