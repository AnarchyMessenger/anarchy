//! Personal accounts, handles (`username#tag`), spaces and direct conversations.
//!
//! A handle is a lowercase username plus a four-digit tag, like Discord's
//! pre-2023 names: two people can both be `maya`, as `maya#0427` and
//! `maya#8812`. Lookups always need the full handle, so a username alone never
//! reveals who is on the server.

use anarchy_proto::{
    AnonymousSignup, ChannelKind, ChannelMeta, CreateSpace, DirectoryEntry, DmPolicy, DmStarted, Invite,
    JoinSpace, PresenceChoice, Profile, ProfileUpdate, Session, SpaceKind, SpaceSummary, StartDm, Usage,
};
use axum::Json;
use axum::extract::{Path, Query, State};
use serde::Deserialize;
use uuid::Uuid;

use crate::{ApiError, ApiResult, AppState, AuthDevice, AuthUser, auth, now_ms};

/// Frame colours a profile can use (the same names as the desktop frames).
pub const COLORS: &[&str] = &[
    "ember", "cobalt", "spring", "summer", "autumn", "winter", "coral", "ocean", "forest", "dusk",
];

/// Lowercases and checks a username: 2 to 32 of a-z, 0-9, `_`, `.`; no leading,
/// trailing or doubled dots.
pub fn normalize_username(input: &str) -> Result<String, ApiError> {
    let name = input.trim().trim_start_matches('@').to_lowercase();
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.');
    if !(2..=32).contains(&name.len())
        || !ok_chars
        || name.starts_with('.')
        || name.ends_with('.')
        || name.contains("..")
    {
        return Err(ApiError::bad_request(
            "usernames are 2 to 32 characters: letters, digits, _ and . (not at the start or end)",
        ));
    }
    Ok(name)
}

/// A usable username from a display name or email ("Maya Chen" → "maya.chen").
pub fn suggest_username(hint: &str) -> String {
    let mut out = String::new();
    for c in hint.split('@').next().unwrap_or("").chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else if (c == '.' || c == ' ' || c == '-') && !out.is_empty() && !out.ends_with('.') {
            out.push('.');
        }
        if out.len() >= 32 {
            break;
        }
    }
    let out = out.trim_matches('.').to_owned();
    if out.len() >= 2 { out } else { "user".into() }
}

/// Finds a free tag for `username`, keeping `prefer` if it's free.
async fn free_tag(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    username: &str,
    prefer: Option<i32>,
    me: Uuid,
) -> ApiResult<i32> {
    let taken: Vec<i32> = sqlx::query_scalar("SELECT tag FROM users WHERE username = $1 AND id <> $2")
        .bind(username)
        .bind(me)
        .fetch_all(&mut **tx)
        .await?;
    if let Some(t) = prefer
        && !taken.contains(&t)
    {
        return Ok(t);
    }
    if taken.len() >= 9999 {
        return Err(ApiError::conflict("that username is full; pick another one"));
    }
    loop {
        let mut b = [0u8; 2];
        getrandom::fill(&mut b).map_err(|_| ApiError::unavailable("no randomness available"))?;
        let t = (u16::from_le_bytes(b) % 9999) as i32 + 1;
        if !taken.contains(&t) {
            return Ok(t);
        }
    }
}

/// Everything a new or returning account needs: a handle, and on a company
/// server a place in the organisation's space. Safe to call on every sign-in.
pub(crate) async fn ensure_account(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    s: &AppState,
    user_id: Uuid,
    name_hint: &str,
) -> ApiResult<()> {
    // Serialises handle assignment per user; the unique index catches races between users.
    let has: Option<(Option<String>,)> =
        sqlx::query_as("SELECT username FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id)
            .fetch_optional(&mut **tx)
            .await?;
    if matches!(has, Some((None,))) {
        let username = suggest_username(name_hint);
        let tag = free_tag(tx, &username, None, user_id).await?;
        sqlx::query("UPDATE users SET username = $2, tag = $3 WHERE id = $1")
            .bind(user_id)
            .bind(&username)
            .bind(tag)
            .execute(&mut **tx)
            .await?;
    }
    if let Some(space) = s.default_space {
        // Sidekicks aren't members of spaces: they're in the channels their person put them in.
        sqlx::query(
            "INSERT INTO space_members (space_id, user_id, role)
             SELECT $1, $2, 'member' FROM users WHERE id = $2 AND agent_of IS NULL ON CONFLICT DO NOTHING",
        )
        .bind(space)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

// ---------- anonymous accounts ----------

pub async fn anonymous(
    State(s): State<AppState>,
    Json(req): Json<AnonymousSignup>,
) -> ApiResult<Json<Session>> {
    if !s.open_signup {
        return Err(ApiError::forbidden(
            "this server doesn't allow anonymous accounts",
        ));
    }
    let name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if name.is_some_and(|n| n.chars().count() > 64) {
        return Err(ApiError::bad_request(
            "display name must be at most 64 characters",
        ));
    }
    let user_id = Uuid::new_v4();
    let mut tx = s.db.begin().await?;
    sqlx::query(
        "INSERT INTO users (id, org_id, oidc_issuer, oidc_subject, display_name)
         VALUES ($1, $2, 'anarchy:anonymous', $3, $4)",
    )
    .bind(user_id)
    .bind(s.org_id)
    .bind(user_id.to_string())
    .bind(name.unwrap_or("Anonymous"))
    .execute(&mut *tx)
    .await?;
    ensure_account(&mut tx, &s, user_id, name.unwrap_or("anon")).await?;
    // Nothing else can sign this account back in, so its session lasts long.
    let session = create_session_for(&mut tx, &s, user_id, ANONYMOUS_SESSION_MS).await?;
    tx.commit().await?;
    Ok(Json(session))
}

const ANONYMOUS_SESSION_MS: u64 = 365 * 24 * 3600 * 1000;

async fn create_session_for(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    s: &AppState,
    user_id: Uuid,
    ttl_ms: u64,
) -> ApiResult<Session> {
    let (token, hash) = auth::new_session_token();
    let expires_at_ms = now_ms() + ttl_ms;
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))",
    )
    .bind(hash)
    .bind(user_id)
    .bind(expires_at_ms as f64)
    .execute(&mut **tx)
    .await?;
    Ok(Session {
        token,
        user_id,
        org_id: s.org_id,
        expires_at_ms,
        is_guest: false,
    })
}

// ---------- profile ----------

type ProfileRow = (
    Uuid,
    Option<String>,
    Option<String>,
    Option<i32>,
    String,
    Option<String>,
    Option<String>,
    String,
    bool,
    Option<String>,
    bool,
    String,
    bool,
    Option<String>,
    Option<String>,
    String,
);

fn sidekick_of(name: Option<String>, look: Option<String>) -> Option<anarchy_proto::Sidekick> {
    name.zip(look)
        .map(|(name, look)| anarchy_proto::Sidekick { name, look })
}

async fn load_profile(db: &sqlx::PgPool, user: Uuid) -> ApiResult<Profile> {
    let r: ProfileRow = sqlx::query_as(
        "SELECT id, display_name, username, tag, color, avatar, usage, dm_policy, dm_humans_only,
                email, is_guest, oidc_issuer, onboarded, sidekick_name, sidekick_look, presence
         FROM users WHERE id = $1",
    )
    .bind(user)
    .fetch_one(db)
    .await?;
    Ok(Profile {
        user_id: r.0,
        display_name: r.1.unwrap_or_default(),
        username: r.2.unwrap_or_default(),
        tag: r.3.unwrap_or(0) as u16,
        color: r.4,
        avatar: r.5,
        usage: r.6.as_deref().and_then(parse_usage),
        dm_policy: if r.7 == "anyone" {
            DmPolicy::Anyone
        } else {
            DmPolicy::Spaces
        },
        dm_humans_only: r.8,
        email: r.9,
        is_guest: r.10,
        is_anonymous: r.11 == "anarchy:anonymous",
        onboarded: r.12,
        sidekick: sidekick_of(r.13, r.14),
        presence: match r.15.as_str() {
            "busy" => PresenceChoice::Busy,
            "away" => PresenceChoice::Away,
            "invisible" => PresenceChoice::Invisible,
            _ => PresenceChoice::Auto,
        },
    })
}

fn parse_usage(s: &str) -> Option<Usage> {
    serde_json::from_value(serde_json::Value::String(s.to_owned())).ok()
}

fn usage_str(u: Usage) -> &'static str {
    match u {
        Usage::Work => "work",
        Usage::Freelance => "freelance",
        Usage::Personal => "personal",
        Usage::Community => "community",
    }
}

pub async fn me(State(s): State<AppState>, user: AuthUser) -> ApiResult<Json<Profile>> {
    Ok(Json(load_profile(&s.db, user.user_id).await?))
}

pub async fn update_me(
    State(s): State<AppState>,
    user: AuthUser,
    Json(req): Json<ProfileUpdate>,
) -> ApiResult<Json<Profile>> {
    let mut tx = s.db.begin().await?;
    let (cur_name, cur_tag): (Option<String>, Option<i32>) =
        sqlx::query_as("SELECT username, tag FROM users WHERE id = $1 FOR UPDATE")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await?;
    if let Some(name) = &req.display_name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(ApiError::bad_request("display name must be 1 to 64 characters"));
        }
        sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(username) = &req.username {
        let username = normalize_username(username)?;
        if Some(&username) != cur_name.as_ref() {
            // Keep the tag when it's free under the new name, as Discord did.
            let tag = free_tag(&mut tx, &username, cur_tag, user.user_id).await?;
            sqlx::query("UPDATE users SET username = $2, tag = $3 WHERE id = $1")
                .bind(user.user_id)
                .bind(&username)
                .bind(tag)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(color) = &req.color {
        if !COLORS.contains(&color.as_str()) {
            return Err(ApiError::bad_request("unknown colour"));
        }
        sqlx::query("UPDATE users SET color = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(color)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(avatar) = &req.avatar {
        let avatar = avatar.trim();
        // One emoji or symbol: a few code points at most (flags and skin tones use several).
        if avatar.chars().count() > 8 || avatar.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(ApiError::bad_request("the avatar is one emoji or symbol"));
        }
        sqlx::query("UPDATE users SET avatar = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind((!avatar.is_empty()).then_some(avatar))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(sk) = &req.sidekick {
        let name = sk.name.trim();
        let look = sk.look.trim();
        if name.is_empty() {
            sqlx::query("UPDATE users SET sidekick_name = NULL, sidekick_look = NULL WHERE id = $1")
                .bind(user.user_id)
                .execute(&mut *tx)
                .await?;
        } else {
            if name.chars().count() > 24 || name.chars().any(char::is_control) {
                return Err(ApiError::bad_request("a sidekick's name is 1 to 24 characters"));
            }
            if !valid_look(look) {
                return Err(ApiError::bad_request(
                    "a sidekick's look is like s2.orb.calm.52c2ca.100.100.0.a",
                ));
            }
            // A server-side sidekick signs with the name its person gave it.
            sqlx::query("UPDATE users SET display_name = $2 WHERE agent_of = $1")
                .bind(user.user_id)
                .bind(name)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE users SET sidekick_name = $2, sidekick_look = $3 WHERE id = $1")
                .bind(user.user_id)
                .bind(name)
                .bind(look)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(p) = req.presence {
        let v = match p {
            PresenceChoice::Auto => "auto",
            PresenceChoice::Busy => "busy",
            PresenceChoice::Away => "away",
            PresenceChoice::Invisible => "invisible",
        };
        sqlx::query("UPDATE users SET presence = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(v)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(usage) = req.usage {
        sqlx::query("UPDATE users SET usage = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(usage_str(usage))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(policy) = req.dm_policy {
        let v = match policy {
            DmPolicy::Anyone => "anyone",
            DmPolicy::Spaces => "spaces",
        };
        sqlx::query("UPDATE users SET dm_policy = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(v)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(v) = req.dm_humans_only {
        sqlx::query("UPDATE users SET dm_humans_only = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(v)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(v) = req.onboarded {
        sqlx::query("UPDATE users SET onboarded = $2 WHERE id = $1")
            .bind(user.user_id)
            .bind(v)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(load_profile(&s.db, user.user_id).await?))
}

// ---------- directory rows ----------

/// user id, display name, email, is guest, active devices, username, tag, colour, avatar, is agent
pub(crate) type EntryRow = (
    Uuid,
    Option<String>,
    Option<String>,
    bool,
    Vec<Uuid>,
    Option<String>,
    Option<i32>,
    String,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// What others see of someone's presence (D35). Busy and away last only while
/// their app checks in; three minutes without a heartbeat reads as away, thirty
/// as offline. Agents have none.
pub(crate) const PRESENCE_SQL: &str = "CASE WHEN u.is_agent THEN NULL
    WHEN u.presence = 'invisible' OR u.last_seen IS NULL OR u.last_seen < now() - interval '30 minutes' THEN 'offline'
    WHEN u.presence IN ('busy', 'away') THEN u.presence
    WHEN u.last_seen > now() - interval '3 minutes' THEN 'online'
    ELSE 'away' END";

/// A sidekick account is drawn with the design its person chose.
pub(crate) const SIDEKICK_NAME_SQL: &str =
    "coalesce(u.sidekick_name, (SELECT o.sidekick_name FROM users o WHERE o.id = u.agent_of))";
pub(crate) const SIDEKICK_LOOK_SQL: &str =
    "coalesce(u.sidekick_look, (SELECT o.sidekick_look FROM users o WHERE o.id = u.agent_of))";

pub(crate) fn entry_columns() -> String {
    format!(
        "u.id, u.display_name, u.email, u.is_guest,
         coalesce(array_agg(d.id ORDER BY d.created_at) FILTER (WHERE d.id IS NOT NULL), '{{}}'),
         u.username, u.tag, u.color, u.avatar, u.is_agent, {SIDEKICK_NAME_SQL}, {SIDEKICK_LOOK_SQL}, {PRESENCE_SQL}"
    )
}

pub(crate) fn entry(r: EntryRow) -> DirectoryEntry {
    DirectoryEntry {
        user_id: r.0,
        display_name: r.1,
        email: r.2,
        is_guest: r.3,
        devices: r.4,
        username: r.5,
        tag: r.6.map(|t| t as u16),
        color: Some(r.7),
        avatar: r.8,
        is_agent: r.9,
        sidekick: sidekick_of(r.10, r.11),
        presence: r.12.as_deref().and_then(anarchy_proto::Presence::parse),
    }
}

async fn entry_for(db: &sqlx::PgPool, user: Uuid, show_email: bool) -> ApiResult<DirectoryEntry> {
    let row: EntryRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM users u
         LEFT JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL
         WHERE u.id = $1 GROUP BY u.id",
        entry_columns()
    )))
    .bind(user)
    .fetch_one(db)
    .await?;
    let mut e = entry(row);
    if !show_email {
        e.email = None;
    }
    Ok(e)
}

async fn share_a_space(db: &sqlx::PgPool, a: Uuid, b: Uuid) -> ApiResult<bool> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM space_members x JOIN space_members y ON x.space_id = y.space_id
         WHERE x.user_id = $1 AND y.user_id = $2 LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

// ---------- direct conversations ----------

pub async fn start_dm(
    State(s): State<AppState>,
    dev: AuthDevice,
    Json(req): Json<StartDm>,
) -> ApiResult<Json<DmStarted>> {
    let me = dev.user_id;
    let username = req.username.trim().trim_start_matches('@').to_lowercase();
    // One answer for "no such person" and "not accepting": no hints for guessing handles.
    let refused = || {
        ApiError::forbidden(format!(
            "{} isn't taking messages from you. Check the handle, or share a space with them first.",
            anarchy_proto::format_handle(&username, req.tag)
        ))
    };
    let target: Option<(Uuid, String, bool, bool)> = sqlx::query_as(
        "SELECT id, dm_policy, dm_humans_only, is_guest FROM users
         WHERE username = $1 AND tag = $2 AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(&username)
    .bind(req.tag as i32)
    .fetch_optional(&s.db)
    .await?;
    let Some((peer, policy, humans_only, peer_guest)) = target else {
        return Err(refused());
    };
    if peer == me {
        return Err(ApiError::bad_request("that's you"));
    }
    let mut tx = s.db.begin().await?;
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT c.id FROM channels c JOIN channel_members m ON m.channel_id = c.id
         WHERE c.kind = 'dm' AND ((c.dm_a = $1 AND c.dm_b = $2) OR (c.dm_a = $2 AND c.dm_b = $1))
           AND m.device_id = $3 AND m.removed_seq IS NULL
         ORDER BY c.created_at LIMIT 1",
    )
    .bind(me)
    .bind(peer)
    .bind(dev.device_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (channel, created) = match existing {
        Some((id,)) => (id, false),
        None => {
            let (me_agent, me_guest): (bool, bool) =
                sqlx::query_as("SELECT is_agent, is_guest FROM users WHERE id = $1")
                    .bind(me)
                    .fetch_one(&s.db)
                    .await?;
            let shared = share_a_space(&s.db, me, peer).await?;
            // A sidekick talks one to one with its person, nobody else.
            let (me_owner, peer_owner): (Option<Uuid>, Option<Uuid>) = (
                sqlx::query_as::<_, (Option<Uuid>,)>("SELECT agent_of FROM users WHERE id = $1")
                    .bind(me)
                    .fetch_one(&s.db)
                    .await?
                    .0,
                sqlx::query_as::<_, (Option<Uuid>,)>("SELECT agent_of FROM users WHERE id = $1")
                    .bind(peer)
                    .fetch_one(&s.db)
                    .await?
                    .0,
            );
            let own_sidekick = peer_owner == Some(me) || me_owner == Some(peer);
            // Guests only talk to people they share a space with, both ways.
            let allowed = own_sidekick
                || (me_owner.is_none() && peer_owner.is_none())
                    && (policy == "anyone" || shared)
                    && !(humans_only && me_agent)
                    && ((!me_guest && !peer_guest) || shared);
            if !allowed {
                return Err(refused());
            }

            let inserted = sqlx::query(
                "INSERT INTO channels (id, org_id, created_by_device, kind, dm_a, dm_b)
                 VALUES ($1, $2, $3, 'dm', $4, $5) ON CONFLICT (id) DO NOTHING",
            )
            .bind(req.channel)
            .bind(dev.org_id)
            .bind(dev.device_id)
            .bind(me)
            .bind(peer)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if inserted == 0 {
                return Err(ApiError::conflict("channel already exists"));
            }
            sqlx::query("INSERT INTO channel_members (channel_id, device_id, added_seq) VALUES ($1, $2, 0)")
                .bind(req.channel)
                .bind(dev.device_id)
                .execute(&mut *tx)
                .await?;
            (req.channel, true)
        }
    };
    tx.commit().await?;
    Ok(Json(DmStarted {
        channel,
        created,
        peer: entry_for(&s.db, peer, false).await?,
    }))
}

/// `GET /v1/channels`: the caller's channels with their space or DM peer.
pub async fn my_channels(State(s): State<AppState>, dev: AuthDevice) -> ApiResult<Json<Vec<ChannelMeta>>> {
    /// channel, kind, space, DM person a, DM person b
    type Row = (Uuid, String, Option<Uuid>, Option<Uuid>, Option<Uuid>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT c.id, c.kind, c.space_id, c.dm_a, c.dm_b FROM channels c
         JOIN channel_members m ON m.channel_id = c.id
         WHERE m.device_id = $1 AND m.removed_seq IS NULL ORDER BY c.created_at",
    )
    .bind(dev.device_id)
    .fetch_all(&s.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, kind, space, a, b) in rows {
        let dm = kind == "dm";
        let peer = match (dm, a, b) {
            (true, Some(a), Some(b)) => {
                Some(entry_for(&s.db, if a == dev.user_id { b } else { a }, false).await?)
            }
            _ => None,
        };
        out.push(ChannelMeta {
            id,
            kind: match kind.as_str() {
                "dm" => ChannelKind::Dm,
                "personal" => ChannelKind::Personal,
                _ => ChannelKind::Channel,
            },
            space,
            peer,
        });
    }
    Ok(Json(out))
}

// ---------- spaces ----------

fn kind_str(k: SpaceKind) -> &'static str {
    match k {
        SpaceKind::Company => "company",
        SpaceKind::Community => "community",
        SpaceKind::Personal => "personal",
        SpaceKind::Freelance => "freelance",
    }
}

fn parse_kind(s: &str) -> SpaceKind {
    match s {
        "company" => SpaceKind::Company,
        "community" => SpaceKind::Community,
        "freelance" => SpaceKind::Freelance,
        _ => SpaceKind::Personal,
    }
}

pub(crate) async fn require_space_member(db: &sqlx::PgPool, space: Uuid, user: Uuid) -> ApiResult<String> {
    let role: Option<(String,)> =
        sqlx::query_as("SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2")
            .bind(space)
            .bind(user)
            .fetch_optional(db)
            .await?;
    role.map(|r| r.0)
        .ok_or_else(|| ApiError::not_found("no such space"))
}

async fn summary(db: &sqlx::PgPool, space: Uuid, user: Uuid) -> ApiResult<SpaceSummary> {
    let (id, name, kind, is_default, role, members): (Uuid, String, String, bool, String, i64) =
        sqlx::query_as(
            "SELECT s.id, s.name, s.kind, s.is_default, m.role,
                (SELECT count(*) FROM space_members x WHERE x.space_id = s.id)
         FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $2 WHERE s.id = $1",
        )
        .bind(space)
        .bind(user)
        .fetch_one(db)
        .await?;
    Ok(SpaceSummary {
        id,
        name,
        kind: parse_kind(&kind),
        role,
        members: members as u32,
        is_default,
    })
}

pub async fn create_space(
    State(s): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateSpace>,
) -> ApiResult<Json<SpaceSummary>> {
    if user.is_guest {
        return Err(ApiError::forbidden("guests can't create spaces"));
    }
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(ApiError::bad_request("space names are 1 to 64 characters"));
    }
    let id = Uuid::new_v4();
    let mut tx = s.db.begin().await?;
    sqlx::query("INSERT INTO spaces (id, org_id, name, kind, created_by) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(s.org_id)
        .bind(name)
        .bind(kind_str(req.kind))
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(summary(&s.db, id, user.user_id).await?))
}

/// Owners rename a space. The name is visible to the server (it routes invites
/// and lists spaces); what's said inside stays encrypted.
pub async fn rename_space(
    State(s): State<AppState>,
    user: AuthUser,
    Path(space): Path<Uuid>,
    Json(req): Json<anarchy_proto::RenameSpace>,
) -> ApiResult<Json<SpaceSummary>> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(ApiError::bad_request("space names are 1 to 64 characters"));
    }
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2")
            .bind(space)
            .bind(user.user_id)
            .fetch_optional(&s.db)
            .await?;
    match role.as_deref() {
        None => return Err(ApiError::not_found("no such space")),
        Some("owner") => {}
        Some(_) => return Err(ApiError::forbidden("only the space's owners can rename it")),
    }
    sqlx::query("UPDATE spaces SET name = $1 WHERE id = $2")
        .bind(name)
        .bind(space)
        .execute(&s.db)
        .await?;
    Ok(Json(summary(&s.db, space, user.user_id).await?))
}

/// Leaves a space. The organisation's own space can't be left, and a space
/// keeps at least one owner.
pub async fn leave_space(
    State(s): State<AppState>,
    user: AuthUser,
    Path(space): Path<Uuid>,
) -> ApiResult<axum::http::StatusCode> {
    let row: Option<(String, bool)> = sqlx::query_as(
        "SELECT m.role, sp.is_default FROM space_members m JOIN spaces sp ON sp.id = m.space_id
         WHERE m.space_id = $1 AND m.user_id = $2",
    )
    .bind(space)
    .bind(user.user_id)
    .fetch_optional(&s.db)
    .await?;
    let (role, is_default) = row.ok_or_else(|| ApiError::not_found("no such space"))?;
    if is_default {
        return Err(ApiError::forbidden("everyone stays in the organisation's space"));
    }
    if role == "owner" {
        let owners: i64 =
            sqlx::query_scalar("SELECT count(*) FROM space_members WHERE space_id = $1 AND role = 'owner'")
                .bind(space)
                .fetch_one(&s.db)
                .await?;
        if owners <= 1 {
            return Err(ApiError::bad_request(
                "you're the only owner; make someone else an owner first",
            ));
        }
    }
    sqlx::query("DELETE FROM space_members WHERE space_id = $1 AND user_id = $2")
        .bind(space)
        .bind(user.user_id)
        .execute(&s.db)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn my_spaces(State(s): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<SpaceSummary>>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT s.id FROM spaces s JOIN space_members m ON m.space_id = s.id
         WHERE m.user_id = $1 ORDER BY s.is_default DESC, m.joined_at",
    )
    .bind(user.user_id)
    .fetch_all(&s.db)
    .await?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(summary(&s.db, id, user.user_id).await?);
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct SpaceInviteRequest {
    pub expires_in_secs: u64,
    pub max_uses: u32,
}

pub async fn create_space_invite(
    State(s): State<AppState>,
    user: AuthUser,
    Path(space): Path<Uuid>,
    Json(req): Json<SpaceInviteRequest>,
) -> ApiResult<Json<Invite>> {
    require_space_member(&s.db, space, user.user_id).await?;
    if user.is_guest {
        return Err(ApiError::forbidden("guests can't invite people"));
    }
    if !(60..=crate::MAX_INVITE_SECS).contains(&req.expires_in_secs) {
        return Err(ApiError::bad_request("invites last between 1 minute and 30 days"));
    }
    if !(1..=1000).contains(&req.max_uses) {
        return Err(ApiError::bad_request("an invite can be used 1 to 1000 times"));
    }
    let (code, hash) = auth::new_invite_code();
    let id = Uuid::new_v4();
    let expires_at_ms = now_ms() + req.expires_in_secs * 1000;
    sqlx::query(
        "INSERT INTO invites (id, org_id, code_hash, created_by, expires_at, max_uses, space_id)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)",
    )
    .bind(id)
    .bind(s.org_id)
    .bind(hash)
    .bind(user.user_id)
    .bind(expires_at_ms as f64)
    .bind(req.max_uses as i32)
    .bind(space)
    .execute(&s.db)
    .await?;
    Ok(Json(Invite {
        id,
        code,
        expires_at_ms,
        max_uses: req.max_uses,
    }))
}

pub async fn join_space(
    State(s): State<AppState>,
    user: AuthUser,
    Json(req): Json<JoinSpace>,
) -> ApiResult<Json<SpaceSummary>> {
    let mut tx = s.db.begin().await?;
    let invite: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, space_id FROM invites
         WHERE code_hash = $1 AND org_id = $2 AND space_id IS NOT NULL AND revoked_at IS NULL
           AND expires_at > now() AND uses < max_uses
         FOR UPDATE",
    )
    .bind(auth::hash_invite_code(&req.invite_code))
    .bind(s.org_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (invite_id, space) =
        invite.ok_or_else(|| ApiError::forbidden("this invite code isn't valid; ask for a new one"))?;
    let joined = sqlx::query(
        "INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    )
    .bind(space)
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if joined == 1 {
        sqlx::query("UPDATE invites SET uses = uses + 1 WHERE id = $1")
            .bind(invite_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(summary(&s.db, space, user.user_id).await?))
}

#[derive(Deserialize)]
pub struct DirectoryQuery {
    pub space: Option<Uuid>,
}

/// People who share a space with the caller (or one given space), with their
/// active devices. Email addresses are shown only within company spaces.
pub async fn directory(
    State(s): State<AppState>,
    user: AuthUser,
    Query(q): Query<DirectoryQuery>,
) -> ApiResult<Json<Vec<DirectoryEntry>>> {
    if user.is_guest {
        return Err(ApiError::forbidden("guests can't browse the directory"));
    }
    if let Some(space) = q.space {
        require_space_member(&s.db, space, user.user_id).await?;
    }
    let rows: Vec<EntryRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM users u
         LEFT JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL
         WHERE (u.expires_at IS NULL OR u.expires_at > now())
           AND u.id IN (SELECT y.user_id FROM space_members x JOIN space_members y ON x.space_id = y.space_id
                        WHERE x.user_id = $1 AND ($2::uuid IS NULL OR x.space_id = $2))
         GROUP BY u.id ORDER BY lower(coalesce(u.display_name, u.username, u.id::text))",
        entry_columns()
    )))
    .bind(user.user_id)
    .bind(q.space)
    .fetch_all(&s.db)
    .await?;
    let company = s.default_space.is_some();
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                let mut e = entry(r);
                if !company {
                    e.email = None;
                }
                e
            })
            .collect(),
    ))
}

/// A sidekick's look (D34): `s2.<shape>.<face>.<rrggbb>.<eye size>.<spacing>.<tilt>.<ink>[.<headwear>]`,
/// or the older `<shape>-<colour>`. Others' apps draw it, so it stays plain data.
fn valid_look(look: &str) -> bool {
    let word = |p: &str| (2..=12).contains(&p.len()) && p.chars().all(|c| c.is_ascii_lowercase());
    let num = |p: &str, lo: i32, hi: i32| p.parse::<i32>().is_ok_and(|n| (lo..=hi).contains(&n));
    if let Some(rest) = look.strip_prefix("s2.") {
        let parts: Vec<&str> = rest.split('.').collect();
        // An eighth field, headwear, is optional (D40).
        return (parts.len() == 7 || (parts.len() == 8 && word(parts[7])))
            && word(parts[0])
            && word(parts[1])
            && parts[2].len() == 6
            && parts[2]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            && num(parts[3], 60, 160)
            && num(parts[4], 60, 160)
            && num(parts[5], -20, 20)
            && matches!(parts[6], "a" | "b" | "w");
    }
    look.split_once('-')
        .is_some_and(|(shape, colour)| word(shape) && word(colour))
}

/// Lookups a person may make per hour.
const LOOKUPS_PER_HOUR: u32 = 60;

/// `POST /v1/directory/by-email`: the person behind an address, if the caller
/// could already start a conversation with them here: they share a space, or
/// that person takes messages from anyone (D39). Everyone else, and addresses
/// with no account, get the same `null`, so the answer doesn't reveal who has
/// an account. Capped per hour against testing addresses in bulk.
pub async fn by_email(
    State(s): State<AppState>,
    user: AuthUser,
    Json(req): Json<anarchy_proto::EmailLookup>,
) -> ApiResult<Json<Option<DirectoryEntry>>> {
    if user.is_guest {
        return Err(ApiError::forbidden("guests can't look people up"));
    }
    {
        let hour = now_ms() / 3_600_000;
        let mut map = s.lookups.lock().expect("lookup counter");
        let e = map.entry(user.user_id).or_insert((hour, 0));
        if e.0 != hour {
            *e = (hour, 0);
        }
        if e.1 >= LOOKUPS_PER_HOUR {
            return Err(ApiError::forbidden("too many lookups; try again in an hour"));
        }
        e.1 += 1;
    }
    let email = req.email.trim().to_lowercase();
    let target: Option<(Uuid, String, bool, bool)> = sqlx::query_as(
        "SELECT id, dm_policy, dm_humans_only, is_agent FROM users
         WHERE lower(email) = $1 AND id <> $2 AND NOT is_guest AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1",
    )
    .bind(&email)
    .bind(user.user_id)
    .fetch_optional(&s.db)
    .await?;
    let Some((peer, policy, _humans_only, is_agent)) = target else {
        return Ok(Json(None));
    };
    if is_agent || !(policy == "anyone" || share_a_space(&s.db, user.user_id, peer).await?) {
        return Ok(Json(None));
    }
    Ok(Json(Some(entry_for(&s.db, peer, false).await?)))
}

/// `POST /v1/me/heartbeat`: the app is open and someone is using it (D35).
/// Apps call it about once a minute and stop while the person is idle.
pub async fn heartbeat(State(s): State<AppState>, user: AuthUser) -> ApiResult<axum::http::StatusCode> {
    sqlx::query("UPDATE users SET last_seen = now() WHERE id = $1")
        .bind(user.user_id)
        .execute(&s.db)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames() {
        assert_eq!(suggest_username("Maya Chen"), "maya.chen");
        assert_eq!(suggest_username("léa.b@northwind.org"), "la.b");
        assert_eq!(suggest_username("🙂"), "user");
        assert!(normalize_username("Maya_C").is_ok());
        assert!(normalize_username("a").is_err());
        assert!(normalize_username(".maya").is_err());
        assert!(normalize_username("ma..ya").is_err());
        assert!(normalize_username("maya chen").is_err());
    }
}
