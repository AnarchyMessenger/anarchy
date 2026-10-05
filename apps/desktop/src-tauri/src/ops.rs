//! What the app can do. Every function runs on the engine thread (see engine.rs).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anarchy_core::{Client, Content, DeskItem, ItemRecord, Trust, oidc};
use anarchy_proto::{
    AuthConfig, ChannelId, ChannelKind, DeviceId, DirectoryEntry, Profile, ProfileUpdate, Session, SpaceId,
    SpaceKind, SpaceSummary, UserId, format_handle, parse_handle,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::engine::{Account, Inner, SavedSession, read_json, write_json};
use crate::storage::{self, Storage};

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const KEY_PACKAGES_PER_SIGN_IN: usize = 5;
pub const FRAMES: [&str; 10] = [
    "ember", "cobalt", "spring", "summer", "autumn", "winter", "coral", "ocean", "forest", "dusk",
];

fn err(e: anarchy_core::Error) -> String {
    match e {
        anarchy_core::Error::Api { message, .. } => capitalise(&message),
        anarchy_core::Error::Http(_) => "Couldn't reach the server. Check your connection.".into(),
        other => other.to_string(),
    }
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

// ---------- appearance & preferences ----------

#[derive(Clone, Serialize, Deserialize)]
pub struct Appearance {
    pub display: String,
    pub frame: String,
    /// False until the person has been through the "Make it yours" step once.
    #[serde(default)]
    pub chosen: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            display: "system".into(),
            frame: "ember".into(),
            chosen: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NotificationPrefs {
    /// Show desktop notifications at all.
    pub desktop: bool,
    /// Only when someone @mentions you by name.
    pub mentions_only: bool,
    /// Include the message text (off: "New message in #channel").
    pub previews: bool,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            desktop: true,
            mentions_only: false,
            previews: true,
        }
    }
}

// ---------- status ----------

#[derive(Serialize)]
pub struct Status {
    locked: bool,
    profile: Option<Profile>,
    device_id: String,
    storage: Storage,
    appearance: Appearance,
    notifications: NotificationPrefs,
    last_server: Option<String>,
    /// Where new accounts go unless an email domain, an invite or the person says otherwise.
    default_server: String,
    session: Option<SessionInfo>,
    /// A local account: everything personal works, nothing that needs a server does (D38).
    local: bool,
}

#[derive(Serialize)]
pub struct SessionInfo {
    server: String,
    org_name: String,
    is_guest: bool,
    display_name: Option<String>,
    email: Option<String>,
    expires_at_ms: u64,
    user_id: UserId,
}

pub async fn status(i: &mut Inner) -> Result<Status, String> {
    if i.is_local() {
        let lp = crate::local::profile_of(i.device()).expect("local");
        i.profile = Some(crate::local::as_profile(i.device(), &lp));
    }
    if i.saved().is_some() && i.profile.is_none() {
        // Offline is fine: the app works from the saved session and fills this in later.
        if let Ok(p) = i.client()?.me().await {
            i.profile = Some(p);
        }
    }
    let device = i.device();
    Ok(Status {
        locked: i.is_locked(),
        profile: i.profile.clone(),
        device_id: device.id().to_string(),
        storage: i.storage.clone(),
        appearance: read_json(device, "appearance").unwrap_or_default(),
        notifications: read_json(device, "notifications").unwrap_or_default(),
        last_server: read_json(device, "last_server"),
        default_server: default_server(),
        local: i.is_local(),
        session: i.saved().map(|s| SessionInfo {
            server: s.server.clone(),
            org_name: s.org_name.clone(),
            is_guest: s.session.is_guest,
            display_name: s.display_name.clone(),
            email: s.email.clone(),
            expires_at_ms: s.session.expires_at_ms,
            user_id: s.session.user_id,
        }),
    })
}

pub async fn set_appearance(i: &mut Inner, display: String, frame: String) -> Result<(), String> {
    if !["light", "dark", "system", "luna"].contains(&display.as_str()) || !FRAMES.contains(&frame.as_str()) {
        return Err("Unknown appearance".into());
    }
    write_json(
        i.device(),
        "appearance",
        &Appearance {
            display,
            frame,
            chosen: true,
        },
    )
}

pub async fn set_notifications(i: &mut Inner, prefs: NotificationPrefs) -> Result<(), String> {
    write_json(i.device(), "notifications", &prefs)
}

// ---------- device lock ----------

pub async fn unlock(i: &mut Inner, passphrase: String) -> Result<(), String> {
    if !i.is_locked() {
        return Ok(());
    }
    let dir = i.data_dir.clone();
    // Argon2 is deliberately slow; keep the engine's runtime free while it runs.
    let (device, storage, key) = tokio::task::spawn_blocking(move || storage::unlock(&dir, &passphrase))
        .await
        .map_err(|e| e.to_string())??;
    i.unlocked(device, storage, key);
    Ok(())
}

/// Protects this device with a passphrase (asked for at every start from now on).
pub async fn set_passphrase(i: &mut Inner, passphrase: String) -> Result<(), String> {
    let key = i.key.ok_or("This device can't be protected with a passphrase")?;
    let dir = i.data_dir.clone();
    let storage = tokio::task::spawn_blocking(move || storage::set_passphrase(&dir, &key, &passphrase))
        .await
        .map_err(|e| e.to_string())??;
    i.storage = storage;
    Ok(())
}

// ---------- sign-in ----------

#[derive(Serialize)]
pub struct Workspace {
    server: String,
    config: AuthConfig,
}

/// The public server new people land on. Set at build time with
/// `ANARCHY_DEFAULT_SERVER` (or at run time, for development).
pub fn default_server() -> String {
    std::env::var("ANARCHY_DEFAULT_SERVER")
        .ok()
        .or_else(|| option_env!("ANARCHY_DEFAULT_SERVER").map(str::to_owned))
        .unwrap_or_else(|| "https://anarchy.chat".to_owned())
}

/// Looks for the server the email's organisation runs (see `oidc::discover_server`).
pub async fn discover_server(_i: &mut Inner, email: String) -> Result<Option<String>, String> {
    Ok(oidc::discover_server(&email).await)
}

/// Accepts what people type ("chat.northwind.org", "https://…"). Plain http only for this computer.
pub fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err("Enter your workspace address, for example chat.northwind.org".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let (scheme, host) = scheme_and_host(&with_scheme).ok_or("That doesn't look like a web address")?;
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match scheme.as_str() {
        "https" => Ok(with_scheme),
        "http" if local => Ok(with_scheme),
        "http" => Err("Use https:// for workspaces on other computers".into()),
        _ => Err("Workspace addresses start with https://".into()),
    }
}

fn scheme_and_host(s: &str) -> Option<(String, String)> {
    let (scheme, rest) = s.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if host.starts_with('[') {
        host.split_inclusive(']').next()?.to_owned()
    } else {
        host.split(':').next()?.to_owned()
    };
    if host.is_empty()
        || host.contains(' ')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-[]:".contains(c))
    {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

pub async fn workspace_info(i: &mut Inner, server: String) -> Result<Workspace, String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(|e| match e {
        anarchy_core::Error::Http(_) => {
            format!("Couldn't reach {server}. Check the address and your connection.")
        }
        other => other.to_string(),
    })?;
    write_json(i.device(), "last_server", &server)?;
    Ok(Workspace { server, config })
}

pub async fn sign_in_sso(
    i: &mut Inner,
    server: String,
    cancel: Arc<Notify>,
    show_link: Box<dyn Fn(String) + Send>,
) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(err)?;
    let pending = oidc::begin(&config).await.map_err(err)?;
    if open::that_detached(&pending.url).is_err() {
        // No default browser, or it failed: let the person open the link themselves.
        show_link(pending.url.clone());
    }
    let id_token = tokio::select! {
        r = pending.finish(SIGN_IN_TIMEOUT) => r.map_err(err)?,
        _ = cancel.notified() => return Err("Sign-in cancelled".into()),
    };
    let session = Client::login_with_id_token(&server, &id_token)
        .await
        .map_err(err)?;
    attach(i, server, config.org_name, session, None, None).await
}

pub async fn request_email_code(_i: &mut Inner, server: String, email: String) -> Result<(), String> {
    let server = normalize_server(&server)?;
    Client::request_email_code(&server, &email).await.map_err(err)
}

pub async fn sign_in_email(i: &mut Inner, server: String, email: String, code: String) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(err)?;
    let session = Client::login_with_email_code(&server, &email, &code)
        .await
        .map_err(err)?;
    let name = email.trim().split('@').next().map(str::to_owned);
    attach(
        i,
        server,
        config.org_name,
        session,
        name,
        Some(email.trim().to_lowercase()),
    )
    .await
}

pub async fn sign_in_anonymous(i: &mut Inner, server: String, name: String) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(err)?;
    let name = name.trim();
    let session = Client::login_anonymously(&server, (!name.is_empty()).then_some(name))
        .await
        .map_err(err)?;
    attach(i, server, config.org_name, session, None, None).await
}

pub async fn join_as_guest(i: &mut Inner, server: String, code: String, name: String) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(err)?;
    let session = Client::login_as_guest(&server, &code, &name).await.map_err(err)?;
    attach(
        i,
        server,
        config.org_name,
        session,
        Some(name.trim().to_owned()),
        None,
    )
    .await
}

/// Puts the device behind a new session: registers it, publishes key packages
/// so people can add it to channels, and saves the session. On failure the
/// device goes back to the signed-out state, untouched.
async fn attach(
    i: &mut Inner,
    server: String,
    org_name: String,
    session: Session,
    display_name: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    let device = match std::mem::replace(&mut i.account, Account::Moving) {
        Account::SignedOut(d) => d,
        Account::SignedIn(c, _) => (*c).into_device(),
        Account::Moving => unreachable!(),
    };
    let mut client = Client::from_session(&server, session.clone(), device);
    let registered = async {
        client.register_device().await?;
        client.publish_key_packages(KEY_PACKAGES_PER_SIGN_IN).await
    }
    .await;
    // Someone who started on this computer brings it all with them (D38).
    if registered.is_ok() && crate::local::profile_of(client.device()).is_some() {
        match crate::local::migrate(&mut client, &i.data_dir).await {
            Ok(m) => eprintln!(
                "anarchy: moved {} desks, {} records, {} files into the account",
                m.desks, m.items, m.files
            ),
            // Keep the local copies; signing in again tries once more.
            Err(e) => eprintln!("anarchy: couldn't move the local account yet: {e}"),
        }
    }
    let profile = match &registered {
        Ok(()) => client.me().await.ok(),
        Err(_) => None,
    };
    let saved = SavedSession {
        server,
        org_name,
        session,
        display_name: profile.as_ref().map(|p| p.display_name.clone()).or(display_name),
        email: profile.as_ref().and_then(|p| p.email.clone()).or(email),
    };
    if let Err(e) = registered
        .map_err(err)
        .and_then(|()| write_json(client.device(), "session", &saved))
    {
        i.account = Account::SignedOut(client.into_device());
        return Err(e);
    }
    i.members.clear();
    i.metas.clear();
    i.profile = profile;
    i.account = Account::SignedIn(Box::new(client), saved);
    Ok(())
}

pub async fn sign_out(i: &mut Inner) -> Result<(), String> {
    i.account = match std::mem::replace(&mut i.account, Account::Moving) {
        Account::SignedIn(client, _) => {
            let device = (*client).into_device();
            device.delete_setting("session").map_err(|e| e.to_string())?;
            Account::SignedOut(device)
        }
        signed_out => signed_out,
    };
    i.members.clear();
    i.metas.clear();
    i.profile = None;
    i.focused = None;
    Ok(())
}

// ---------- profile ----------

pub async fn me(i: &mut Inner) -> Result<Profile, String> {
    if i.is_local() {
        let lp = crate::local::profile_of(i.device()).expect("local");
        return Ok(crate::local::as_profile(i.device(), &lp));
    }
    let p = i.client()?.me().await.map_err(err)?;
    i.profile = Some(p.clone());
    Ok(p)
}

pub async fn update_profile(i: &mut Inner, update: ProfileUpdate) -> Result<Profile, String> {
    if i.is_local() {
        let lp = crate::local::update(i.device(), update)?;
        let p = crate::local::as_profile(i.device(), &lp);
        i.profile = Some(p.clone());
        return Ok(p);
    }
    let p = i.client()?.update_me(&update).await.map_err(err)?;
    // Keep the saved session's name in step, for offline starts.
    if let Account::SignedIn(client, saved) = &mut i.account {
        saved.display_name = Some(p.display_name.clone());
        write_json(client.device(), "session", &*saved)?;
    }
    i.profile = Some(p.clone());
    Ok(p)
}

// ---------- spaces ----------

pub async fn rename_space(i: &mut Inner, space: SpaceId, name: String) -> Result<SpaceSummary, String> {
    i.client()?.rename_space(space, &name).await.map_err(err)
}

pub async fn leave_space(i: &mut Inner, space: SpaceId) -> Result<(), String> {
    i.client()?.leave_space(space).await.map_err(err)
}

/// A desktop notification (reminders). Shown through the same path as
/// message notifications, so it never blocks the engine.
pub async fn notify(i: &mut Inner, title: String, body: String) -> Result<(), String> {
    let prefs: NotificationPrefs = read_json(i.device(), "notifications").unwrap_or_default();
    if prefs.desktop {
        (i.notify)(title, body);
    }
    Ok(())
}

pub async fn spaces(i: &mut Inner) -> Result<Vec<SpaceSummary>, String> {
    if i.is_local() {
        return Ok(vec![]);
    }
    i.client()?.spaces().await.map_err(err)
}

pub async fn create_space(i: &mut Inner, name: String, kind: SpaceKind) -> Result<SpaceSummary, String> {
    i.client()?.create_space(name.trim(), kind).await.map_err(err)
}

pub async fn join_space(i: &mut Inner, code: String) -> Result<SpaceSummary, String> {
    i.client()?.join_space(code.trim()).await.map_err(err)
}

pub async fn create_space_invite(
    i: &mut Inner,
    space: SpaceId,
    hours: u64,
    max_uses: u32,
) -> Result<InviteView, String> {
    let invite = i
        .client()?
        .create_space_invite(space, Duration::from_secs(hours * 3600), max_uses)
        .await
        .map_err(err)?;
    Ok(InviteView {
        code: invite.code,
        expires_at_ms: invite.expires_at_ms,
        max_uses: invite.max_uses,
    })
}

// ---------- direct conversations ----------

#[derive(Serialize, Clone)]
pub struct PeerView {
    user_id: UserId,
    name: String,
    handle: Option<String>,
    color: String,
    avatar: Option<String>,
    is_guest: bool,
    is_agent: bool,
    sidekick: Option<anarchy_proto::Sidekick>,
    presence: Option<anarchy_proto::Presence>,
}

fn peer_view(p: &DirectoryEntry) -> PeerView {
    PeerView {
        user_id: p.user_id,
        name: p
            .display_name
            .clone()
            .or(p.username.clone())
            .unwrap_or_else(|| "Someone".into()),
        handle: p.username.as_ref().zip(p.tag).map(|(u, t)| format_handle(u, t)),
        color: p.color.clone().unwrap_or_else(|| "ember".into()),
        avatar: p.avatar.clone(),
        is_guest: p.is_guest,
        is_agent: p.is_agent,
        sidekick: p.sidekick.clone(),
        presence: p.presence,
    }
}

/// Opens (or finds) the conversation with `@username#tag`.
pub async fn start_dm(i: &mut Inner, handle: String) -> Result<ChannelId, String> {
    let (username, tag) = parse_handle(&handle)
        .ok_or("Type the whole handle, like maya#0427 (the number is on their profile)")?;
    let (channel, _peer, skipped) = i.client()?.start_dm(&username, tag).await.map_err(err)?;
    i.metas.clear();
    refresh_members(i, channel).await?;
    if !skipped.is_empty() {
        // They exist but have no device ready: the conversation waits for them.
        eprintln!("anarchy: {} device(s) couldn't be added yet", skipped.len());
    }
    Ok(channel)
}

async fn refresh_metas(i: &mut Inner) -> Result<(), String> {
    let metas = i.client()?.channel_metas().await.map_err(err)?;
    i.metas = metas.into_iter().map(|m| (m.id, m)).collect();
    Ok(())
}

// ---------- channels and messages ----------

#[derive(Serialize)]
pub struct ChannelView {
    id: ChannelId,
    /// `channel` or `dm`.
    kind: &'static str,
    space: Option<SpaceId>,
    /// Set for desks, e.g. `collections`.
    desk: Option<String>,
    /// For a DM: the other person.
    peer: Option<PeerView>,
    name: String,
    topic: String,
    trust: Trust,
    last_text: Option<String>,
    last_ts: u64,
    unread: bool,
}

#[derive(Serialize)]
pub struct MessageView {
    seq: u64,
    sender: String,
    mine: bool,
    ts_ms: u64,
    text: String,
    /// The thread this reply belongs to (the root message's `seq`).
    thread: Option<u64>,
    /// Set when a sidekick wrote it: whose it is, so nobody takes it for the person.
    agent: Option<AgentTag>,
    /// How the sender looks: colour, picture, sidekick (D35).
    look: Option<SenderLook>,
}

#[derive(Serialize)]
pub struct AgentTag {
    owner: String,
    mine: bool,
    /// The design its person chose.
    look: Option<String>,
}

#[derive(Serialize)]
pub struct SenderLook {
    color: Option<String>,
    avatar: Option<String>,
    sidekick: Option<anarchy_proto::Sidekick>,
}

fn sender_look(i: &Inner, channel: ChannelId, device: DeviceId) -> Option<SenderLook> {
    let m = i.members.get(&channel)?.iter().find(|m| m.device_id == device)?;
    Some(SenderLook {
        color: m.color.clone(),
        avatar: m.avatar.clone(),
        sidekick: m.sidekick.clone(),
    })
}

fn agent_tag(i: &Inner, channel: ChannelId, device: DeviceId) -> Option<AgentTag> {
    let ms = i.members.get(&channel)?;
    let agent = ms.iter().find(|m| m.device_id == device)?;
    let owner = agent.agent_of?;
    let me = i.saved().map(|s| s.session.user_id);
    Some(AgentTag {
        owner: ms
            .iter()
            .find(|m| m.user_id == owner)
            .and_then(|m| m.display_name.clone())
            .unwrap_or_else(|| "someone".into()),
        mine: Some(owner) == me,
        look: agent.sidekick.as_ref().map(|s| s.look.clone()),
    })
}

/// Last read sequence number per channel.
type ReadMarks = HashMap<ChannelId, u64>;

pub async fn list_channels(i: &mut Inner) -> Result<Vec<ChannelView>, String> {
    if i.is_local() {
        return Ok(crate::local::list(i.device())
            .into_iter()
            .map(|(id, kind)| ChannelView {
                id,
                kind: "personal",
                space: None,
                name: crate::local::desk_name(&kind).into(),
                desk: Some(kind),
                peer: None,
                topic: String::new(),
                trust: Trust::Sealed,
                last_text: None,
                last_ts: 0,
                unread: false,
            })
            .collect());
    }
    let me = i.my_device();
    let local = i.client()?.device().channels();
    if local.iter().any(|c| !i.metas.contains_key(c)) {
        // Offline: list what we have, without spaces.
        let _ = refresh_metas(i).await;
    }
    let metas = i.metas.clone();
    let client = i.client()?;
    let marks: ReadMarks = read_json(client.device(), "read").unwrap_or_default();
    let mut out = Vec::new();
    for id in client.device().channels() {
        if crate::local::is_local(client.device(), id) {
            continue;
        }
        let history = client.device().messages(id, 200).map_err(|e| e.to_string())?;
        let (name, topic, trust) = client
            .channel_info(id)
            .map_err(err)?
            .unwrap_or_else(|| ("untitled".into(), String::new(), Trust::Sealed));
        let last = history.iter().rev().find_map(|m| {
            Content::decode(&m.content)
                .text_body()
                .map(|t| (t.to_owned(), m.ts_ms, m.seq, m.sender))
        });
        let unread = last
            .as_ref()
            .is_some_and(|(_, _, seq, sender)| *sender != me && *seq > marks.get(&id).copied().unwrap_or(0));
        let meta = metas.get(&id);
        let peer = meta.and_then(|m| m.peer.as_ref()).map(peer_view);
        out.push(ChannelView {
            id,
            kind: match meta.map(|m| &m.kind) {
                Some(ChannelKind::Dm) => "dm",
                Some(ChannelKind::Personal) => "personal",
                _ => "channel",
            },
            space: meta.and_then(|m| m.space),
            desk: client.desk_kind(id).map_err(err)?,
            name: peer.as_ref().map_or(name, |p| p.name.clone()),
            peer,
            topic,
            trust,
            last_ts: last.as_ref().map_or(0, |l| l.1),
            last_text: last.map(|l| l.0),
            unread,
        });
    }
    // Channels by name; DMs by most recent activity.
    out.sort_by(|a, b| match (a.kind, b.kind) {
        ("dm", "dm") => b.last_ts.cmp(&a.last_ts),
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

fn sender_name(i: &Inner, channel: ChannelId, device: DeviceId) -> String {
    if device == i.my_device() {
        return i
            .saved()
            .and_then(|s| s.display_name.clone())
            .unwrap_or_else(|| "You".into());
    }
    i.members
        .get(&channel)
        .and_then(|ms| ms.iter().find(|m| m.device_id == device))
        .map(|m| {
            let name = m.display_name.clone().unwrap_or_else(|| "Someone".into());
            if m.is_guest {
                format!("{name} (guest)")
            } else {
                name
            }
        })
        .unwrap_or_else(|| "Former member".into())
}

async fn refresh_members(i: &mut Inner, channel: ChannelId) -> Result<(), String> {
    let members = i.client()?.members(channel).await.map_err(err)?;
    i.members.insert(channel, members);
    Ok(())
}

pub async fn open_channel(i: &mut Inner, channel: ChannelId) -> Result<Vec<MessageView>, String> {
    if crate::local::is_local(i.device(), channel) {
        return Ok(vec![]);
    }
    i.focused = Some(channel);
    if !i.members.contains_key(&channel) {
        refresh_members(i, channel).await?;
    }
    let history = i
        .client()?
        .device()
        .messages(channel, 500)
        .map_err(|e| e.to_string())?;
    if let Some(last) = history.last() {
        let device = i.device();
        let mut marks: ReadMarks = read_json(device, "read").unwrap_or_default();
        marks.insert(channel, last.seq);
        write_json(device, "read", &marks)?;
    }
    let me = i.my_device();
    Ok(history
        .iter()
        .filter_map(|m| {
            let content = Content::decode(&m.content);
            let text = content.text_body()?.to_owned();
            Some(MessageView {
                seq: m.seq,
                sender: sender_name(i, channel, m.sender),
                mine: m.sender == me,
                ts_ms: m.ts_ms,
                text,
                thread: content.thread(),
                agent: agent_tag(i, channel, m.sender),
                look: sender_look(i, channel, m.sender),
            })
        })
        .collect())
}

pub async fn blur(i: &mut Inner) -> Result<(), String> {
    i.focused = None;
    Ok(())
}

/// Sends a message, or a reply in the thread started by message `thread`.
pub async fn send_message(
    i: &mut Inner,
    channel: ChannelId,
    text: String,
    thread: Option<u64>,
) -> Result<(), String> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Ok(());
    }
    let content = match thread {
        Some(root) => Content::reply(text, root),
        None => Content::text(text),
    };
    let client = i.client()?;
    match client.send_content(channel, &content).await {
        // Someone changed the channel meanwhile: catch up, then try once more.
        Err(anarchy_core::Error::StaleEpoch { .. }) => {
            client.sync_and_store(channel).await.map_err(err)?;
            client.send_content(channel, &content).await.map_err(err)?;
        }
        other => {
            other.map_err(err)?;
        }
    }
    Ok(())
}

pub async fn create_channel(
    i: &mut Inner,
    space: Option<SpaceId>,
    name: String,
    topic: String,
    trust: Trust,
) -> Result<ChannelId, String> {
    let name = name
        .trim()
        .trim_start_matches('#')
        .to_lowercase()
        .replace(' ', "-");
    if name.is_empty() || name.chars().count() > 64 {
        return Err("Channel names are 1 to 64 characters".into());
    }
    let id = i
        .client()?
        .create_named_channel_in(space, &name, topic.trim(), trust)
        .await
        .map_err(err)?;
    i.metas.clear();
    refresh_members(i, id).await?;
    Ok(id)
}

// ---------- search ----------

#[derive(Serialize)]
pub struct SearchHit {
    channel: ChannelId,
    /// `message` or `record`.
    what: &'static str,
    seq: u64,
    ts_ms: u64,
    /// Who wrote it (messages), or the record's kind (records).
    by: String,
    text: String,
}

/// Searches this device's decrypted history and desk records. Nothing leaves
/// the computer: the server can't search what it can't read.
pub async fn search(i: &mut Inner, query: String) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let me = i.my_device();
    let mut hits = Vec::new();
    let channels = i.device().channels();
    for channel in channels {
        let history = i.device().messages(channel, 5000).map_err(|e| e.to_string())?;
        for m in history.iter().rev() {
            if let Some(text) = Content::decode(&m.content).text_body()
                && text.to_lowercase().contains(&q)
            {
                let by = if m.sender == me {
                    "You".to_owned()
                } else {
                    sender_name(i, channel, m.sender)
                };
                hits.push(SearchHit {
                    channel,
                    what: "message",
                    seq: m.seq,
                    ts_ms: m.ts_ms,
                    by,
                    text: text.to_owned(),
                });
            }
        }
        for item in desk_items(i, channel).await? {
            // Settings and forms hold keys and config, not things people look for.
            if matches!(item.kind.as_str(), "settings" | "form") {
                continue;
            }
            let blob = item.data.to_string().to_lowercase();
            if blob.contains(&q) {
                let text = [
                    "number", "customer", "name", "contact", "what", "folder", "title", "date",
                ]
                .iter()
                .filter_map(|k| item.data.get(*k).and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(" · ");
                hits.push(SearchHit {
                    channel,
                    what: "record",
                    seq: item.seq,
                    ts_ms: item.updated_ms,
                    by: item.kind,
                    text,
                });
            }
        }
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.ts_ms));
    hits.truncate(40);
    Ok(hits)
}

/// Everyone in a space (for its overview page).
pub async fn space_members(i: &mut Inner, space: SpaceId) -> Result<Vec<PeerView>, String> {
    let list = i.client()?.directory_in(space).await.map_err(err)?;
    Ok(list.iter().map(peer_view).collect())
}

// ---------- desks ----------

pub const DESK_KINDS: [&str; 4] = ["collections", "files", "tasks", "pages"];

pub async fn create_desk(
    i: &mut Inner,
    space: Option<SpaceId>,
    name: String,
    kind: String,
) -> Result<ChannelId, String> {
    if !DESK_KINDS.contains(&kind.as_str()) {
        return Err("That kind of desk isn't available yet".into());
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("Desk names are 1 to 64 characters".into());
    }
    let id = i.client()?.create_desk(space, name, &kind).await.map_err(err)?;
    i.metas.clear();
    refresh_members(i, id).await?;
    Ok(id)
}

pub async fn desk_items(i: &mut Inner, channel: ChannelId) -> Result<Vec<DeskItem>, String> {
    if crate::local::is_local(i.device(), channel) {
        return crate::local::items(i.device(), channel);
    }
    i.client()?.desk_items(channel).map_err(err)
}

// ---------- drive ----------

/// This person's own desk of `kind` (`agenda`, `notes`), made the first time.
/// Only their devices are in it: nobody else, the server included, can read it.
pub async fn ensure_personal(i: &mut Inner, kind: String) -> Result<ChannelId, String> {
    // `prefs` holds how you organise things (sidebar folders), synced between your devices.
    if !matches!(kind.as_str(), "agenda" | "notes" | "files" | "tasks" | "prefs") {
        return Err("Unknown personal desk".into());
    }
    if i.is_local() {
        return crate::local::ensure_desk(i.local_device()?, &kind);
    }
    let _ = refresh_metas(i).await;
    let local = i.client()?.device().channels();
    for id in local {
        let personal = i.metas.get(&id).is_some_and(|m| m.kind == ChannelKind::Personal);
        if personal && i.client()?.desk_kind(id).map_err(err)?.as_deref() == Some(kind.as_str()) {
            return Ok(id);
        }
    }
    let name = match kind.as_str() {
        "agenda" => "Agenda",
        "notes" => "Notes",
        "files" => "My files",
        "prefs" => "Preferences",
        _ => "Tasks",
    };
    let id = i.client()?.create_personal_desk(name, &kind).await.map_err(err)?;
    i.metas.clear();
    Ok(id)
}

/// Replaces a text file in the drive with an edited version (same record, new chunks).
pub async fn save_text_file(
    i: &mut Inner,
    channel: ChannelId,
    id: String,
    text: String,
) -> Result<(), String> {
    let item = desk_items(i, channel)
        .await?
        .into_iter()
        .find(|x| x.id == id && x.kind == "file")
        .ok_or("That file isn't here any more")?;
    let name = item.data["name"].as_str().unwrap_or("note.md").to_owned();
    let folder = item.data["folder"].as_str().unwrap_or("/").to_owned();
    store_file(i, channel, text.as_bytes(), &name, &folder, Some(id)).await?;
    Ok(())
}

/// The space's drive: a desk of kind `files`, made the first time it's opened.
pub async fn ensure_drive(i: &mut Inner, space: SpaceId) -> Result<ChannelId, String> {
    if i.metas.is_empty() {
        let _ = refresh_metas(i).await;
    }
    let local = i.client()?.device().channels();
    for id in local {
        let in_space = i.metas.get(&id).and_then(|m| m.space) == Some(space);
        if in_space && i.client()?.desk_kind(id).map_err(err)?.as_deref() == Some("files") {
            return Ok(id);
        }
    }
    create_desk(i, Some(space), "Files".into(), "files".into()).await
}

/// 200 MB per file for now: chunks go through Postgres.
pub const MAX_FILE: u64 = 200 * 1024 * 1024;

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "json" | "log" => "text/plain",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" | "key" => "application/vnd.ms-powerpoint",
        "zip" => "application/zip",
        "mp4" | "mov" => "video/mp4",
        "mp3" | "wav" | "m4a" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// Encrypts and uploads a file from disk into `folder` of the drive.
pub async fn upload_path(
    i: &mut Inner,
    channel: ChannelId,
    path: std::path::PathBuf,
    folder: String,
) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Folders can't be uploaded yet; pick the files inside".into());
    }
    if meta.len() > MAX_FILE {
        return Err("Files up to 200 MB for now".into());
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    store_file(i, channel, &bytes, &name, &folder, None).await?;
    Ok(name)
}

/// Encrypts `bytes`, uploads the chunks and writes the file's record. Passing
/// the `id` of an existing record replaces that file (latest write wins).
pub async fn store_file(
    i: &mut Inner,
    channel: ChannelId,
    bytes: &[u8],
    name: &str,
    folder: &str,
    id: Option<String>,
) -> Result<String, String> {
    if bytes.len() as u64 > MAX_FILE {
        return Err("Files up to 200 MB for now".into());
    }
    let by = i
        .saved()
        .and_then(|s| s.display_name.clone())
        .or_else(|| crate::local::profile_of(i.device()).map(|p| p.display_name))
        .unwrap_or_else(|| "Someone".into());
    let mut data = if crate::local::is_local(i.device(), channel) {
        crate::local::store_file(&i.data_dir, bytes)?
    } else {
        i.client()?.upload_file(channel, bytes).await.map_err(err)?
    };
    data["name"] = serde_json::json!(name);
    data["folder"] = serde_json::json!(folder);
    data["mime"] = serde_json::json!(mime_for(name));
    data["by"] = serde_json::json!(by);
    // Who added it, by account, so "Created by me" survives a rename.
    data["by_user"] = serde_json::json!(i.saved().map(|s| s.session.user_id));
    data["added"] = serde_json::json!(crate::engine::now_ms());
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    put_items(
        i,
        channel,
        vec![ItemRecord {
            id: id.clone(),
            kind: "file".into(),
            data,
        }],
    )
    .await?;
    Ok(id)
}

async fn file_bytes(
    i: &mut Inner,
    channel: ChannelId,
    id: &str,
) -> Result<(Vec<u8>, serde_json::Value), String> {
    let item = desk_items(i, channel)
        .await?
        .into_iter()
        .find(|x| x.id == id && x.kind == "file")
        .ok_or("That file isn't here any more")?;
    let bytes = if item.data.get("local_chunks").is_some() {
        crate::local::read_file(&i.data_dir, &item.data)?
    } else {
        i.client()?
            .download_file(channel, &item.data)
            .await
            .map_err(err)?
    };
    Ok((bytes, item.data))
}

/// Downloads, decrypts and writes a file where the person chose.
pub async fn save_file(
    i: &mut Inner,
    channel: ChannelId,
    id: String,
    dest: std::path::PathBuf,
) -> Result<(), String> {
    let (bytes, _) = file_bytes(i, channel, &id).await?;
    tokio::task::spawn_blocking(move || std::fs::write(dest, bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Preview {
    /// `image`, `text` or `none`.
    kind: &'static str,
    data: String,
}

/// A look inside images (as a data URL) and text files, decrypted in memory.
pub async fn preview_file(i: &mut Inner, channel: ChannelId, id: String) -> Result<Preview, String> {
    use base64::Engine;
    let (bytes, data) = file_bytes(i, channel, &id).await?;
    let mime = data["mime"].as_str().unwrap_or("");
    Ok(
        if mime.starts_with("image/") && mime != "image/svg+xml" && bytes.len() <= 12 * 1024 * 1024 {
            Preview {
                kind: "image",
                data: format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                ),
            }
        } else if mime == "text/plain" && bytes.len() <= 512 * 1024 {
            Preview {
                kind: "text",
                data: String::from_utf8_lossy(&bytes).into_owned(),
            }
        } else {
            Preview {
                kind: "none",
                data: String::new(),
            }
        },
    )
}

/// Writes one or more records (a bulk "mark as paid" is one message).
pub async fn put_items(i: &mut Inner, channel: ChannelId, items: Vec<ItemRecord>) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    if crate::local::is_local(i.device(), channel) {
        return crate::local::put(i.device(), channel, items);
    }
    let content = if items.len() == 1 {
        let r = items.into_iter().next().expect("one item");
        Content::Item {
            id: r.id,
            kind: r.kind,
            data: r.data,
        }
    } else {
        Content::Items { items }
    };
    let client = i.client()?;
    match client.send_content(channel, &content).await {
        Err(anarchy_core::Error::StaleEpoch { .. }) => {
            client.sync_and_store(channel).await.map_err(err)?;
            client.send_content(channel, &content).await.map_err(err)?;
        }
        other => {
            other.map_err(err)?;
        }
    }
    Ok(())
}

/// Opens a drafted email in the person's own mail app. Anarchy doesn't send
/// mail for desks yet (that's the desk inbox), so it never claims it did.
pub async fn compose_email(_i: &mut Inner, to: String, subject: String, body: String) -> Result<(), String> {
    fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }
    if to.contains(['\r', '\n', '?', '&']) {
        return Err("That email address doesn't look right".into());
    }
    let url = format!(
        "mailto:{}?subject={}&body={}",
        enc(&to).replace("%40", "@"),
        enc(&subject),
        enc(&body)
    );
    open::that_detached(url).map_err(|_| "No mail app is set up on this computer".to_string())
}

#[derive(Serialize)]
pub struct SyncReport {
    new_messages: usize,
    joined: usize,
    removed: usize,
}

/// Pulls invites and new messages for every channel, and notifies about messages
/// from others in channels that aren't on screen.
pub async fn sync_all(i: &mut Inner) -> Result<SyncReport, String> {
    if i.is_local() {
        return Ok(SyncReport {
            new_messages: 0,
            joined: 0,
            removed: 0,
        });
    }
    let me = i.my_device();
    let prefs: NotificationPrefs = read_json(i.device(), "notifications").unwrap_or_default();
    let my_name = i
        .saved()
        .and_then(|s| s.display_name.clone())
        .unwrap_or_default()
        .to_lowercase();
    let client = i.client()?;
    let joined = client.accept_invites().await.map_err(err)?;
    let mut report = SyncReport {
        new_messages: 0,
        joined: joined.len(),
        removed: 0,
    };
    let mut to_notify = Vec::new();
    let leftover = client
        .device()
        .channels()
        .into_iter()
        .filter(|c| crate::local::is_local(client.device(), *c));
    let leftover: Vec<ChannelId> = leftover.collect();
    for channel in client.device().channels() {
        // Local desks not yet moved into the account: they aren't on the server.
        if leftover.contains(&channel) {
            continue;
        }
        let arrived = client.sync_and_store(channel).await.map_err(err)?;
        if !client.device().has_channel(channel) {
            report.removed += 1;
            continue;
        }
        for m in arrived.iter().filter(|m| m.sender != me) {
            if let Some(text) = Content::decode(&m.body).text_body() {
                report.new_messages += 1;
                to_notify.push((channel, m.sender, text.to_owned()));
            }
        }
    }
    if !joined.is_empty() {
        i.metas.clear();
    }
    for channel in joined {
        refresh_members(i, channel).await?;
    }
    // Busy is do-not-disturb: nothing pops up until it's off (D35).
    let busy = i
        .profile
        .as_ref()
        .is_some_and(|p| p.presence == anarchy_proto::PresenceChoice::Busy);
    if prefs.desktop && !busy {
        for (channel, sender, text) in to_notify {
            if i.focused == Some(channel) {
                continue;
            }
            if prefs.mentions_only
                && (my_name.is_empty() || !text.to_lowercase().contains(&format!("@{my_name}")))
            {
                continue;
            }
            if !i
                .members
                .get(&channel)
                .is_some_and(|ms| ms.iter().any(|m| m.device_id == sender))
            {
                refresh_members(i, channel).await?;
            }
            let who = sender_name(i, channel, sender);
            let name = i
                .client()?
                .channel_info(channel)
                .map_err(err)?
                .map(|c| c.0)
                .unwrap_or_default();
            let body = if prefs.previews {
                format!("{who}: {text}")
            } else {
                format!("New message from {who}")
            };
            let title = match i.metas.get(&channel).and_then(|m| m.peer.as_ref()) {
                Some(_) => who.clone(),
                None => format!("#{name}"),
            };
            (i.notify)(title, body);
        }
    }
    Ok(report)
}

// ---------- people ----------

#[derive(Serialize)]
pub struct Person {
    user_id: UserId,
    name: String,
    presence: Option<anarchy_proto::Presence>,
    color: Option<String>,
    avatar: Option<String>,
    sidekick: Option<anarchy_proto::Sidekick>,
    is_agent: bool,
    handle: Option<String>,
    email: Option<String>,
    is_guest: bool,
    can_be_added: bool,
    in_channel: bool,
    me: bool,
}

pub async fn people(i: &mut Inner, channel: Option<ChannelId>) -> Result<Vec<Person>, String> {
    if i.is_local() {
        return Ok(vec![]);
    }
    let me = i.saved().map(|s| s.session.user_id);
    let in_channel: Vec<UserId> = match channel {
        Some(c) => {
            refresh_members(i, c).await?;
            i.members
                .get(&c)
                .map(|ms| ms.iter().map(|m| m.user_id).collect())
                .unwrap_or_default()
        }
        None => vec![],
    };
    let space = channel.and_then(|c| i.metas.get(&c)).and_then(|m| m.space);
    let directory = match space {
        Some(space) => i.client()?.directory_in(space).await,
        None => i.client()?.directory().await,
    }
    .map_err(err)?;
    Ok(directory
        .into_iter()
        .map(|p| Person {
            handle: p.username.as_ref().zip(p.tag).map(|(u, t)| format_handle(u, t)),
            name: p
                .display_name
                .clone()
                .or(p.email.clone())
                .unwrap_or_else(|| "Unnamed".into()),
            can_be_added: !p.devices.is_empty(),
            in_channel: in_channel.contains(&p.user_id),
            me: Some(p.user_id) == me,
            user_id: p.user_id,
            email: p.email,
            is_guest: p.is_guest,
            presence: p.presence,
            color: p.color,
            avatar: p.avatar,
            sidekick: p.sidekick,
            is_agent: p.is_agent,
        })
        .collect())
}

#[derive(Serialize)]
pub struct MemberView {
    user_id: UserId,
    name: String,
    is_guest: bool,
    me: bool,
    is_agent: bool,
    presence: Option<anarchy_proto::Presence>,
    color: Option<String>,
    avatar: Option<String>,
    sidekick: Option<anarchy_proto::Sidekick>,
}

pub async fn channel_members(i: &mut Inner, channel: ChannelId) -> Result<Vec<MemberView>, String> {
    if crate::local::is_local(i.device(), channel) {
        return Ok(vec![]);
    }
    refresh_members(i, channel).await?;
    let me = i.saved().map(|s| s.session.user_id);
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for m in i.members.get(&channel).cloned().unwrap_or_default() {
        if seen.contains(&m.user_id) {
            continue; // one row per person, not per device
        }
        seen.push(m.user_id);
        out.push(MemberView {
            user_id: m.user_id,
            name: m.display_name.unwrap_or_else(|| "Someone".into()),
            is_guest: m.is_guest,
            me: Some(m.user_id) == me,
            is_agent: m.is_agent,
            presence: m.presence,
            color: m.color,
            avatar: m.avatar,
            sidekick: m.sidekick,
        });
    }
    Ok(out)
}

/// Adds people; returns the names of those who couldn't be added yet (no device ready).
pub async fn add_people(
    i: &mut Inner,
    channel: ChannelId,
    users: Vec<UserId>,
) -> Result<Vec<String>, String> {
    let directory = i.client()?.directory().await.map_err(err)?;
    let mut not_ready = Vec::new();
    for user in users {
        let skipped = i.client()?.add_user(channel, user).await.map_err(err)?;
        if !skipped.is_empty() {
            let name = directory
                .iter()
                .find(|p| p.user_id == user)
                .and_then(|p| p.display_name.clone());
            not_ready.push(name.unwrap_or_else(|| "Someone".into()));
        }
    }
    refresh_members(i, channel).await?;
    Ok(not_ready)
}

pub async fn remove_person(i: &mut Inner, channel: ChannelId, user: UserId) -> Result<(), String> {
    if i.saved().is_some_and(|s| s.session.user_id == user) {
        return Err("You can't remove yourself yet; ask another member".into());
    }
    i.client()?.remove_user(channel, user).await.map_err(err)?;
    refresh_members(i, channel).await
}

// ---------- devices and invites ----------

#[derive(Serialize)]
pub struct DeviceView {
    device_id: DeviceId,
    created_at_ms: u64,
    revoked: bool,
    this_device: bool,
}

pub async fn devices(i: &mut Inner) -> Result<Vec<DeviceView>, String> {
    let me = i.my_device();
    let list = i.client()?.my_devices().await.map_err(err)?;
    Ok(list
        .into_iter()
        .map(|d| DeviceView {
            this_device: d.device_id == me,
            device_id: d.device_id,
            created_at_ms: d.created_at_ms,
            revoked: d.revoked,
        })
        .collect())
}

pub async fn revoke_device(i: &mut Inner, device: DeviceId) -> Result<(), String> {
    if device == i.my_device() {
        return Err("To stop using this computer, sign out instead".into());
    }
    i.client()?.revoke_device(device).await.map_err(err)
}

#[derive(Serialize)]
pub struct InviteView {
    code: String,
    expires_at_ms: u64,
    max_uses: u32,
}

pub async fn create_invite(i: &mut Inner, hours: u64, max_uses: u32) -> Result<InviteView, String> {
    let invite = i
        .client()?
        .create_invite(Duration::from_secs(hours * 3600), max_uses)
        .await
        .map_err(err)?;
    Ok(InviteView {
        code: invite.code,
        expires_at_ms: invite.expires_at_ms,
        max_uses: invite.max_uses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_addresses_are_normalised() {
        assert_eq!(
            normalize_server(" chat.northwind.org/ ").unwrap(),
            "https://chat.northwind.org"
        );
        assert_eq!(
            normalize_server("https://chat.northwind.org").unwrap(),
            "https://chat.northwind.org"
        );
        assert_eq!(
            normalize_server("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(
            normalize_server("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(
            normalize_server("http://chat.northwind.org").is_err(),
            "no plain http across the network"
        );
        assert!(normalize_server("http://localhost.evil.test").is_err());
        assert!(normalize_server("ftp://chat.northwind.org").is_err());
        assert!(normalize_server("").is_err());
        assert!(normalize_server("not a url").is_err());
    }
}

// ---------- pay links ----------

#[derive(Serialize)]
pub struct PayLinkView {
    id: String,
    url: String,
}

/// Seals the page on this device and publishes it; the URL carries the key.
pub async fn create_pay_link(
    i: &mut Inner,
    channel: ChannelId,
    page: serde_json::Value,
    expires_at_ms: u64,
) -> Result<PayLinkView, String> {
    let (id, url) = i
        .client()?
        .create_pay_link(channel, &page, expires_at_ms)
        .await
        .map_err(err)?;
    Ok(PayLinkView { id, url })
}

pub async fn update_pay_link(
    i: &mut Inner,
    channel: ChannelId,
    url: String,
    page: serde_json::Value,
) -> Result<(), String> {
    i.client()?
        .update_pay_link(channel, &url, &page)
        .await
        .map_err(err)
}

pub async fn pay_links(
    i: &mut Inner,
    channel: ChannelId,
) -> Result<Vec<anarchy_proto::PayLinkStatus>, String> {
    i.client()?.pay_links(channel).await.map_err(err)
}

pub async fn revoke_pay_link(i: &mut Inner, channel: ChannelId, id: String) -> Result<(), String> {
    i.client()?.revoke_pay_link(channel, &id).await.map_err(err)
}

// ---------- intake forms ----------

#[derive(Serialize)]
pub struct FormKeys {
    public_key: String,
    private_key: String,
}

/// A key pair for a new form; the private half goes into the desk's records.
pub async fn new_form_keys(_i: &mut Inner) -> Result<FormKeys, String> {
    let (public_key, private_key) = anarchy_core::intake::new_keys().map_err(err)?;
    Ok(FormKeys {
        public_key,
        private_key,
    })
}

pub async fn create_form(
    i: &mut Inner,
    channel: ChannelId,
    form: serde_json::Value,
    expires_at_ms: u64,
) -> Result<PayLinkView, String> {
    let (id, url) = i
        .client()?
        .create_form(channel, &form, expires_at_ms)
        .await
        .map_err(err)?;
    Ok(PayLinkView { id, url })
}

pub async fn update_form(
    i: &mut Inner,
    channel: ChannelId,
    url: String,
    form: serde_json::Value,
) -> Result<(), String> {
    i.client()?.update_form(channel, &url, &form).await.map_err(err)
}

pub async fn revoke_form(i: &mut Inner, channel: ChannelId, id: String) -> Result<(), String> {
    i.client()?.revoke_form(channel, &id).await.map_err(err)
}

#[derive(Serialize)]
pub struct FormAnswer {
    sub: i64,
    at_ms: u64,
    data: serde_json::Value,
}

/// Answers waiting on the server, opened with the form's private key. Ones that
/// don't open (junk sent straight at the endpoint) are deleted here, so they
/// can't fill the form's queue.
pub async fn form_answers(
    i: &mut Inner,
    channel: ChannelId,
    id: String,
    private_key: String,
) -> Result<Vec<FormAnswer>, String> {
    let client = i.client()?;
    let mut out = Vec::new();
    for s in client.form_submissions(channel, &id).await.map_err(err)? {
        match anarchy_core::intake::open_submission(&s.sealed, &private_key) {
            Ok(data) => out.push(FormAnswer {
                sub: s.id,
                at_ms: s.at_ms,
                data,
            }),
            Err(_) => client
                .delete_form_submission(channel, &id, s.id)
                .await
                .map_err(err)?,
        }
    }
    Ok(out)
}

/// Call once the answer is saved in the desk.
pub async fn forget_form_answer(
    i: &mut Inner,
    channel: ChannelId,
    id: String,
    sub: i64,
) -> Result<(), String> {
    i.client()?
        .delete_form_submission(channel, &id, sub)
        .await
        .map_err(err)
}

// ---------- server-side sidekick (D32) ----------

#[derive(Serialize)]
pub struct SidekickState {
    /// This server runs sidekicks.
    hosted: bool,
    /// Your sidekick can read this channel.
    on: bool,
    /// Why it can't be turned on here, if it can't.
    blocked: Option<String>,
}

async fn my_sidekick(i: &mut Inner) -> Result<Option<anarchy_proto::SidekickAccount>, String> {
    i.client()?.sidekick_account().await.map_err(err)
}

/// Whether your sidekick reads `channel`, and whether it may.
pub async fn sidekick_state(i: &mut Inner, channel: ChannelId) -> Result<SidekickState, String> {
    if i.is_local() {
        return Ok(SidekickState {
            hosted: false,
            on: false,
            blocked: Some("Connect a server first.".into()),
        });
    }
    let server = i.client()?.server_url().to_owned();
    let hosted = oidc::workspace_config(&server)
        .await
        .map(|c| c.sidekicks_hosted)
        .unwrap_or(false);
    if !hosted {
        return Ok(SidekickState {
            hosted,
            on: false,
            blocked: Some("This server doesn't run sidekicks.".into()),
        });
    }
    let account = my_sidekick(i).await?;
    refresh_members(i, channel).await?;
    let on = account.as_ref().is_some_and(|a| {
        i.members
            .get(&channel)
            .is_some_and(|ms| ms.iter().any(|m| m.user_id == a.user_id))
    });
    Ok(SidekickState {
        hosted,
        on,
        blocked: sidekick_blocked(i, channel).await?,
    })
}

async fn sidekick_blocked(i: &mut Inner, channel: ChannelId) -> Result<Option<String>, String> {
    if !i.metas.contains_key(&channel) {
        refresh_metas(i).await?;
    }
    let kind = i.metas.get(&channel).map(|m| m.kind);
    if matches!(kind, Some(ChannelKind::Dm)) {
        return Ok(Some(
            "Conversations with one person stay between the two of you.".into(),
        ));
    }
    if matches!(kind, Some(ChannelKind::Personal)) {
        return Ok(Some(
            "Your own agenda, notes and files stay on your devices.".into(),
        ));
    }
    let trust = i.client()?.channel_info(channel).map_err(err)?.map(|(_, _, t)| t);
    if trust != Some(Trust::Company) {
        return Ok(Some(
            "Sealed channels promise the server can't read them, so no sidekick can join.".into(),
        ));
    }
    Ok(None)
}

/// Lets your sidekick read `channel` from now on, and says so in the channel.
pub async fn sidekick_join(i: &mut Inner, channel: ChannelId) -> Result<(), String> {
    if let Some(why) = sidekick_blocked(i, channel).await? {
        return Err(why);
    }
    let account = match my_sidekick(i).await? {
        Some(a) if !a.devices.is_empty() => a,
        _ => {
            let a = i.client()?.enable_sidekick().await.map_err(err)?;
            if a.devices.is_empty() {
                return Err("Your sidekick is starting on the server. Try again in a few seconds.".into());
            }
            a
        }
    };
    let name = i
        .profile
        .as_ref()
        .and_then(|p| p.sidekick.as_ref())
        .map_or("My sidekick".to_owned(), |s| s.name.clone());
    let client = i.client()?;
    for d in &account.devices {
        client.add_device(channel, *d).await.map_err(err)?;
    }
    let note = format!(
        "{name}, my sidekick, can read this channel from now on, including what you say here. \
         It runs on the server, so the server's operator could read it too. It only sees messages from now on."
    );
    client
        .send_content(channel, &Content::text(note))
        .await
        .map_err(err)?;
    refresh_members(i, channel).await
}

/// Takes your sidekick out of `channel`; it forgets what it read there.
pub async fn sidekick_leave(i: &mut Inner, channel: ChannelId) -> Result<(), String> {
    let Some(account) = my_sidekick(i).await? else {
        return Ok(());
    };
    refresh_members(i, channel).await?;
    let here: Vec<DeviceId> = i
        .members
        .get(&channel)
        .map(|ms| {
            ms.iter()
                .filter(|m| m.user_id == account.user_id)
                .map(|m| m.device_id)
                .collect()
        })
        .unwrap_or_default();
    if here.is_empty() {
        return Ok(());
    }
    let name = i
        .profile
        .as_ref()
        .and_then(|p| p.sidekick.as_ref())
        .map_or("My sidekick".to_owned(), |s| s.name.clone());
    let client = i.client()?;
    client.remove_devices(channel, &here).await.map_err(err)?;
    client
        .send_content(
            channel,
            &Content::text(format!("{name} can't read this channel any more.")),
        )
        .await
        .map_err(err)?;
    refresh_members(i, channel).await
}

/// Opens your conversation with your sidekick, turning it on first if needed.
pub async fn sidekick_chat(i: &mut Inner) -> Result<ChannelId, String> {
    let account = match my_sidekick(i).await? {
        Some(a) => a,
        None => i.client()?.enable_sidekick().await.map_err(err)?,
    };
    if account.devices.is_empty() {
        return Err("Your sidekick is starting on the server. Try again in a few seconds.".into());
    }
    let (Some(username), Some(tag)) = (account.username.clone(), account.tag) else {
        return Err("Your sidekick has no handle yet. Try again in a few seconds.".into());
    };
    start_dm(i, format_handle(&username, tag)).await
}

/// The app is open and someone is using it (D35). The UI calls this about
/// once a minute and stops while the person is idle.
pub async fn heartbeat(i: &mut Inner) -> Result<(), String> {
    if i.is_local() {
        return Ok(());
    }
    i.client()?.heartbeat().await.map_err(err)
}

// ---------- mail (D37) ----------
// The account and recent mail live in this device's encrypted database; mail
// goes between this computer and the person's provider, never through the
// Anarchy server. Shown as plain text.

const MAIL_KEEP: usize = 300;

#[derive(Serialize, serde::Deserialize, Default)]
struct MailCache {
    uid_validity: Option<u32>,
    mails: Vec<anarchy_mail::Mail>,
}

#[derive(Serialize)]
pub struct MailStatus {
    email: Option<String>,
    name: Option<String>,
}

fn mail_account(i: &Inner) -> Option<anarchy_mail::Account> {
    read_json(i.device(), "mail:account")
}

pub async fn mail_preset(_i: &mut Inner, email: String) -> Result<Option<anarchy_mail::Preset>, String> {
    Ok(anarchy_mail::preset(&email))
}

pub async fn mail_status(i: &mut Inner) -> Result<MailStatus, String> {
    let a = mail_account(i);
    Ok(MailStatus {
        email: a.as_ref().map(|a| a.email.clone()),
        name: a.and_then(|a| a.name),
    })
}

/// Checks the settings by signing in, then keeps them.
pub async fn mail_connect(i: &mut Inner, account: anarchy_mail::Account) -> Result<(), String> {
    anarchy_mail::check(&account).await.map_err(|e| e.to_string())?;
    write_json(i.device(), "mail:account", &account)?;
    write_json(i.device(), "mail:cache", &MailCache::default())?;
    Ok(())
}

/// Forgets the account and every message kept from it.
pub async fn mail_disconnect(i: &mut Inner) -> Result<(), String> {
    for k in ["mail:account", "mail:cache"] {
        i.device().delete_setting(k).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn mail_list(i: &mut Inner) -> Result<Vec<anarchy_mail::Mail>, String> {
    Ok(read_json::<MailCache>(i.device(), "mail:cache")
        .unwrap_or_default()
        .mails)
}

/// Fetches what's new and returns everything kept.
pub async fn mail_sync(i: &mut Inner) -> Result<Vec<anarchy_mail::Mail>, String> {
    let Some(account) = mail_account(i) else {
        return Ok(vec![]);
    };
    let mut cache: MailCache = read_json(i.device(), "mail:cache").unwrap_or_default();
    let newest = cache.mails.iter().map(|m| m.uid).max();
    let got = anarchy_mail::fetch(&account, newest, 100)
        .await
        .map_err(|e| e.to_string())?;
    if got.uid_validity != cache.uid_validity {
        // The server renumbered the mailbox: start over from what it has now.
        cache = MailCache {
            uid_validity: got.uid_validity,
            mails: vec![],
        };
        let fresh = anarchy_mail::fetch(&account, None, 100)
            .await
            .map_err(|e| e.to_string())?;
        cache.mails = fresh.mails;
    } else {
        cache.mails.extend(got.mails);
    }
    cache.mails.sort_by_key(|m| std::cmp::Reverse(m.date_ms));
    cache.mails.dedup_by_key(|m| m.uid);
    cache.mails.truncate(MAIL_KEEP);
    write_json(i.device(), "mail:cache", &cache)?;
    Ok(cache.mails)
}

pub async fn mail_seen(i: &mut Inner, uid: u32, seen: bool) -> Result<(), String> {
    let Some(account) = mail_account(i) else {
        return Ok(());
    };
    anarchy_mail::set_seen(&account, uid, seen)
        .await
        .map_err(|e| e.to_string())?;
    let mut cache: MailCache = read_json(i.device(), "mail:cache").unwrap_or_default();
    if let Some(m) = cache.mails.iter_mut().find(|m| m.uid == uid) {
        m.seen = seen;
    }
    write_json(i.device(), "mail:cache", &cache)
}

pub async fn mail_send(i: &mut Inner, out: anarchy_mail::Outgoing) -> Result<(), String> {
    let account = mail_account(i).ok_or("Connect a mail account first.")?;
    anarchy_mail::send(&account, &out)
        .await
        .map_err(|e| e.to_string())
}

// ---------- local account (D38) ----------

/// Starts using Anarchy on this computer, with no server.
pub async fn start_local(i: &mut Inner, name: String) -> Result<Profile, String> {
    if i.saved().is_some() {
        return Err("You're already signed in".into());
    }
    let lp = crate::local::create(i.device(), &name)?;
    let p = crate::local::as_profile(i.device(), &lp);
    i.profile = Some(p.clone());
    Ok(p)
}

// ---------- email threads that upgrade (D39) ----------
// Someone you email may be on Anarchy too. You ask (nothing is looked up on
// its own: a lookup tells the server who you write to); if they are, the
// thread continues in an encrypted conversation, and the app remembers it for
// that address.

pub async fn mail_find(i: &mut Inner, email: String) -> Result<Option<PeerView>, String> {
    if i.is_local() {
        return Err("Connect a server to find people.".into());
    }
    Ok(i.client()?
        .lookup_email(&email)
        .await
        .map_err(err)?
        .as_ref()
        .map(peer_view))
}

/// Opens (or finds) the conversation with whoever is behind `email`, and keeps the link.
pub async fn mail_continue(i: &mut Inner, email: String) -> Result<ChannelId, String> {
    let peer = i
        .client()?
        .lookup_email(&email)
        .await
        .map_err(err)?
        .ok_or("They aren't someone you can message here.")?;
    let (Some(u), Some(t)) = (peer.username.clone(), peer.tag) else {
        return Err("They have no handle yet.".into());
    };
    let channel = start_dm(i, format_handle(&u, t)).await?;
    let mut links: HashMap<String, ChannelId> = read_json(i.device(), "mail:upgraded").unwrap_or_default();
    links.insert(email.trim().to_lowercase(), channel);
    write_json(i.device(), "mail:upgraded", &links)?;
    Ok(channel)
}

/// Addresses whose threads continue in Anarchy, and where.
pub async fn mail_links(i: &mut Inner) -> Result<HashMap<String, ChannelId>, String> {
    Ok(read_json(i.device(), "mail:upgraded").unwrap_or_default())
}
