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
    /// OpenID Connect issuer, when the organisation signs in with an identity provider.
    pub issuer: Option<String>,
    /// The public client ID registered for Anarchy at the identity provider.
    pub client_id: Option<String>,
    /// Whether people can sign in with a one-time code sent to their work email.
    #[serde(default)]
    pub email_enabled: bool,
    /// Whether people can join with an invite code instead of an account.
    pub guests_enabled: bool,
    /// Public server: anyone may create an account, and there is no default space.
    #[serde(default)]
    pub open_signup: bool,
    /// Whether this server runs sidekicks for people (D32).
    #[serde(default)]
    pub sidekicks_hosted: bool,
    /// Whether "Continue anonymously" is offered (open servers only).
    #[serde(default)]
    pub anonymous_enabled: bool,
    /// For providers such as Google that require one from installed apps. Not a
    /// secret in that case: every copy of the app carries it (RFC 8252 §8.5).
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// `POST /v1/auth/anonymous`: an account with no email and no provider. It lives
/// only in the session on the device that made it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnonymousSignup {
    pub display_name: Option<String>,
}

/// Who may start a direct conversation with you.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DmPolicy {
    /// Anyone who knows your handle.
    Anyone,
    /// Only people who share a space with you.
    #[default]
    Spaces,
}

/// What someone plans to use Anarchy for; picks sensible defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Usage {
    Work,
    Freelance,
    Personal,
    Community,
}

/// `GET /v1/me` and the body of `PUT /v1/me`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub user_id: UserId,
    pub display_name: String,
    /// Lowercase, 2 to 32 characters of a-z, 0-9, `_` and `.`.
    pub username: String,
    /// Four digits, shown as `#0427`. With the username it identifies the person.
    pub tag: u16,
    /// A frame colour name, e.g. `ember`.
    pub color: String,
    /// One emoji or symbol, or `None` for initials.
    pub avatar: Option<String>,
    pub usage: Option<Usage>,
    pub dm_policy: DmPolicy,
    /// Refuse direct conversations from accounts marked as AI agents.
    pub dm_humans_only: bool,
    pub email: Option<String>,
    pub is_guest: bool,
    pub is_anonymous: bool,
    /// False until the person has finished onboarding.
    pub onboarded: bool,
    /// The person's sidekick: their own agent, shown as a badge on their avatar.
    #[serde(default)]
    pub sidekick: Option<Sidekick>,
    /// What the person chose to show others (D35).
    #[serde(default)]
    pub presence: PresenceChoice,
}

/// What someone chose to show (D35). `Auto` follows whether their app is open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceChoice {
    #[default]
    Auto,
    /// Do not disturb: shown as busy, and their apps hold notifications.
    Busy,
    Away,
    /// Shown as offline.
    Invisible,
}

/// What others see: worked out from the choice and when their app last checked in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    Online,
    Busy,
    Away,
    Offline,
}

impl Presence {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "online" => Some(Self::Online),
            "busy" => Some(Self::Busy),
            "away" => Some(Self::Away),
            "offline" => Some(Self::Offline),
            _ => None,
        }
    }
}

/// A person's sidekick as others see it. `look` is `s2.<shape>.<face>.<rrggbb>.<size>.<gap>.<tilt>.<ink>` (D34), or the older `<shape>-<colour>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sidekick {
    pub name: String,
    pub look: String,
}

/// `GET`/`POST /v1/me/sidekick`: the account a person's server-side sidekick
/// signs in as, and its devices. Adding one of those devices to a channel lets
/// the sidekick (and so the server's operator) read it (D32).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidekickAccount {
    pub user_id: UserId,
    pub devices: Vec<DeviceId>,
    /// Its handle, for starting the conversation with it.
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub tag: Option<u16>,
}

/// `GET /v1/host/agents`: the sidekicks the host runs, for the sidekick host only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedAgent {
    pub user_id: UserId,
    pub owner: UserId,
    pub name: String,
}

/// `PUT /v1/me`: the fields a person can change. Missing fields stay as they are.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileUpdate {
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub color: Option<String>,
    /// `Some("")` clears it back to initials.
    pub avatar: Option<String>,
    pub usage: Option<Usage>,
    pub dm_policy: Option<DmPolicy>,
    pub dm_humans_only: Option<bool>,
    pub onboarded: Option<bool>,
    /// A name of `""` removes the sidekick.
    #[serde(default)]
    pub sidekick: Option<Sidekick>,
    #[serde(default)]
    pub presence: Option<PresenceChoice>,
}

/// Formats a handle the way people read it: `maya#0427`.
pub fn format_handle(username: &str, tag: u16) -> String {
    format!("{username}#{tag:04}")
}

/// Parses `@maya#0427`, `maya#427` or `Maya#0427` into `("maya", 427)`.
pub fn parse_handle(input: &str) -> Option<(String, u16)> {
    let s = input.trim().trim_start_matches('@');
    let (name, tag) = s.rsplit_once('#')?;
    let tag: u16 = tag.trim().parse().ok()?;
    let name = name.trim().to_lowercase();
    (!name.is_empty() && (1..=9999).contains(&tag)).then_some((name, tag))
}

pub type SpaceId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceKind {
    Company,
    Community,
    Personal,
    Freelance,
}

/// `POST /v1/spaces`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSpace {
    pub name: String,
    pub kind: SpaceKind,
}

/// `PUT /v1/spaces/{space}`: owners rename a space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameSpace {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceSummary {
    pub id: SpaceId,
    pub name: String,
    pub kind: SpaceKind,
    /// `owner` or `member`.
    pub role: String,
    pub members: u32,
    /// The organisation's own space on a company server; everyone is in it.
    pub is_default: bool,
}

/// `POST /v1/spaces/join`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinSpace {
    pub invite_code: String,
}

/// `POST /v1/dms`: start (or find) a direct conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartDm {
    pub username: String,
    pub tag: u16,
    /// ID for the new conversation if none exists yet. The client has already
    /// created an MLS group with it.
    pub channel: ChannelId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmStarted {
    /// The new ID, or an existing conversation's.
    pub channel: ChannelId,
    pub created: bool,
    pub peer: DirectoryEntry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Channel,
    Dm,
    /// One person's own records, synced between their devices.
    Personal,
}

/// `GET /v1/channels`: routing facts about the caller's channels. Names and
/// topics are encrypted and not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelMeta {
    pub id: ChannelId,
    pub kind: ChannelKind,
    pub space: Option<SpaceId>,
    /// For a direct conversation: the other person.
    pub peer: Option<DirectoryEntry>,
}

/// `POST /v1/auth/email/start`: send a one-time code to a work address.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailStart {
    pub email: String,
}

/// `POST /v1/auth/email/verify`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailVerify {
    pub email: String,
    pub code: String,
}

/// `GET /v1/directory`: people in the organisation (members only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryEntry {
    pub user_id: UserId,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub is_guest: bool,
    /// Active devices; adding a person to a channel adds each of these.
    pub devices: Vec<DeviceId>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub tag: Option<u16>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub is_agent: bool,
    /// Theirs, or for a sidekick its person's: the design it's drawn with.
    #[serde(default)]
    pub sidekick: Option<Sidekick>,
    /// `None` for agents.
    #[serde(default)]
    pub presence: Option<Presence>,
}

/// `GET /v1/devices`: the caller's own devices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceSummary {
    pub device_id: DeviceId,
    pub created_at_ms: u64,
    pub revoked: bool,
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
    /// The space it belongs to. On a company server, `None` means the default space.
    #[serde(default)]
    pub space: Option<SpaceId>,
    /// A personal channel: only the creator's own devices, in no space
    /// (their agenda, their notes).
    #[serde(default)]
    pub personal: bool,
}

/// `GET /v1/channels/{channel}/members`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub device_id: DeviceId,
    pub user_id: UserId,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub is_guest: bool,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub tag: Option<u16>,
    #[serde(default)]
    pub is_agent: bool,
    /// For a sidekick: the person it works for.
    #[serde(default)]
    pub agent_of: Option<UserId>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    /// Theirs, or for a sidekick its person's design.
    #[serde(default)]
    pub sidekick: Option<Sidekick>,
    #[serde(default)]
    pub presence: Option<Presence>,
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

#[cfg(test)]
mod handle_tests {
    use super::*;

    #[test]
    fn handles_round_trip() {
        assert_eq!(format_handle("maya", 427), "maya#0427");
        assert_eq!(parse_handle("@Maya#0427"), Some(("maya".into(), 427)));
        assert_eq!(parse_handle("maya#427"), Some(("maya".into(), 427)));
        assert_eq!(parse_handle("maya"), None);
        assert_eq!(parse_handle("maya#0"), None);
        assert_eq!(parse_handle("#0427"), None);
    }
}

/// `POST /v1/channels/{channel}/blobs` (raw encrypted bytes) answers with this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobRef {
    pub id: Uuid,
}

/// `POST /v1/channels/{channel}/pay_links`: a pay-this-invoice page for someone
/// without an account. `sealed` is base64 of nonce ‖ AES-256-GCM ciphertext,
/// made on a member's device; the key travels only in the link's `#fragment`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePayLink {
    pub sealed: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayLinkCreated {
    pub id: String,
}

/// `PUT /v1/channels/{channel}/pay_links/{id}`: new content under the same
/// link and key (e.g. after the invoice is marked paid).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePayLink {
    pub sealed: String,
}

/// What members see about a link. The server never knows what's in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayLinkStatus {
    pub id: String,
    pub expires_at_ms: u64,
    pub revoked: bool,
    pub views: u32,
    pub last_viewed_at_ms: Option<u64>,
    /// When the person who opened it pressed "I've paid". A claim, not a payment.
    pub claimed_paid_at_ms: Option<u64>,
}

/// `GET /p/{id}/sealed`, public: what the page decrypts in the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicPayLink {
    pub sealed: String,
    pub claimed_paid_at_ms: Option<u64>,
}

/// `POST /v1/channels/{channel}/forms`: an intake form for people without an
/// account. `sealed` is the form's definition, sealed like a pay link (key in
/// the link's `#fragment`); it carries the public key answers are encrypted to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateForm {
    pub sealed: String,
    pub expires_at_ms: u64,
}

/// One answer to a form, as the server holds it: encrypted to the form's key,
/// which only the desk's members have. Members delete it once imported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormSubmission {
    pub id: i64,
    pub sealed: String,
    pub at_ms: u64,
}

/// `POST /f/{id}/submit`, public.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmitForm {
    pub sealed: String,
}
