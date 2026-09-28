//! What the app can do. Every function runs on the engine thread (see engine.rs).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anarchy_core::{Client, Content, Trust, oidc};
use anarchy_proto::{AuthConfig, ChannelId, DeviceId, Session, UserId};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::engine::{Account, Inner, SavedSession, read_json, write_json};
use crate::storage::Storage;

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const KEY_PACKAGES_PER_SIGN_IN: usize = 5;
pub const FRAMES: [&str; 9] = [
    "cobalt", "spring", "summer", "autumn", "winter", "coral", "ocean", "forest", "dusk",
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
            frame: "cobalt".into(),
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
    device_id: String,
    storage: Storage,
    appearance: Appearance,
    notifications: NotificationPrefs,
    last_server: Option<String>,
    session: Option<SessionInfo>,
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
    let device = i.device();
    Ok(Status {
        device_id: device.id().to_string(),
        storage: i.storage.clone(),
        appearance: read_json(device, "appearance").unwrap_or_default(),
        notifications: read_json(device, "notifications").unwrap_or_default(),
        last_server: read_json(device, "last_server"),
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

// ---------- sign-in ----------

#[derive(Serialize)]
pub struct Workspace {
    server: String,
    config: AuthConfig,
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
    let client = Client::from_session(&server, session.clone(), device);
    let registered = async {
        client.register_device().await?;
        client.publish_key_packages(KEY_PACKAGES_PER_SIGN_IN).await
    }
    .await;
    let saved = SavedSession {
        server,
        org_name,
        session,
        display_name,
        email,
    };
    if let Err(e) = registered
        .map_err(err)
        .and_then(|()| write_json(client.device(), "session", &saved))
    {
        i.account = Account::SignedOut(client.into_device());
        return Err(e);
    }
    i.members.clear();
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
    i.focused = None;
    Ok(())
}

// ---------- channels and messages ----------

#[derive(Serialize)]
pub struct ChannelView {
    id: ChannelId,
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
}

/// Last read sequence number per channel.
type ReadMarks = HashMap<ChannelId, u64>;

pub async fn list_channels(i: &mut Inner) -> Result<Vec<ChannelView>, String> {
    let me = i.my_device();
    let client = i.client()?;
    let marks: ReadMarks = read_json(client.device(), "read").unwrap_or_default();
    let mut out = Vec::new();
    for id in client.device().channels() {
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
        out.push(ChannelView {
            id,
            name,
            topic,
            trust,
            last_ts: last.as_ref().map_or(0, |l| l.1),
            last_text: last.map(|l| l.0),
            unread,
        });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
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
            let text = Content::decode(&m.content).text_body()?.to_owned();
            Some(MessageView {
                seq: m.seq,
                sender: sender_name(i, channel, m.sender),
                mine: m.sender == me,
                ts_ms: m.ts_ms,
                text,
            })
        })
        .collect())
}

pub async fn blur(i: &mut Inner) -> Result<(), String> {
    i.focused = None;
    Ok(())
}

pub async fn send_message(i: &mut Inner, channel: ChannelId, text: String) -> Result<(), String> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Ok(());
    }
    let client = i.client()?;
    match client.send_content(channel, &Content::text(text.clone())).await {
        // Someone changed the channel meanwhile: catch up, then try once more.
        Err(anarchy_core::Error::StaleEpoch { .. }) => {
            client.sync_and_store(channel).await.map_err(err)?;
            client
                .send_content(channel, &Content::text(text))
                .await
                .map_err(err)?;
        }
        other => {
            other.map_err(err)?;
        }
    }
    Ok(())
}

pub async fn create_channel(
    i: &mut Inner,
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
        .create_named_channel(&name, topic.trim(), trust)
        .await
        .map_err(err)?;
    refresh_members(i, id).await?;
    Ok(id)
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
    for channel in client.device().channels() {
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
    for channel in joined {
        refresh_members(i, channel).await?;
    }
    if prefs.desktop {
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
            (i.notify)(format!("#{name}"), body);
        }
    }
    Ok(report)
}

// ---------- people ----------

#[derive(Serialize)]
pub struct Person {
    user_id: UserId,
    name: String,
    email: Option<String>,
    is_guest: bool,
    can_be_added: bool,
    in_channel: bool,
    me: bool,
}

pub async fn people(i: &mut Inner, channel: Option<ChannelId>) -> Result<Vec<Person>, String> {
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
    let directory = i.client()?.directory().await.map_err(err)?;
    Ok(directory
        .into_iter()
        .map(|p| Person {
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
        })
        .collect())
}

#[derive(Serialize)]
pub struct MemberView {
    user_id: UserId,
    name: String,
    is_guest: bool,
    me: bool,
}

pub async fn channel_members(i: &mut Inner, channel: ChannelId) -> Result<Vec<MemberView>, String> {
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
