//! Sidekicks that run on the server (D32).
//!
//! A person's sidekick is an account of its own (`is_agent`, `agent_of`) whose
//! devices live in the sidekick host (`anarchy-sidekick`), not on the person's
//! computers. The rules that keep it from seeing more than its person:
//!
//! - only its person can add its devices to a channel, and only while they're in it (`append`);
//! - it reads and writes a channel only while its person is still in it
//!   ([`owner_present`]), so leaving or being removed cuts it off at once,
//!   before anyone commits its removal;
//! - it can't add or remove anyone itself;
//! - nobody but its person can start a conversation with it.
//!
//! The server can't tell a Sealed channel from a Company one (that's in the
//! encrypted channel info), so refusing Sealed channels is the client's job.
//! Joining is visible: the sidekick is a member everyone in the channel sees.

use anarchy_proto::{ChannelId, DeviceId, HostedAgent, Session, SidekickAccount, UserId};
use axum::Json;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{AuthDevice, AuthUser};
use crate::{ApiError, ApiResult, AppState, accounts, now_ms};

/// Sessions the host gets for a sidekick; it asks again when one runs out.
const HOST_SESSION_MS: u64 = 24 * 3600 * 1000;

/// If `device` is a sidekick's, whether its person has a device in `channel`.
/// Everyone else's devices pass.
pub(crate) async fn owner_present(db: &PgPool, channel: ChannelId, device: DeviceId) -> ApiResult<bool> {
    let owner: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT u.agent_of FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = $1")
            .bind(device)
            .fetch_optional(db)
            .await?;
    let Some((Some(owner),)) = owner else {
        return Ok(true);
    };
    let present: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM channel_members m JOIN devices d ON d.id = m.device_id
         WHERE m.channel_id = $1 AND m.removed_seq IS NULL AND d.user_id = $2 AND d.revoked_at IS NULL LIMIT 1",
    )
    .bind(channel)
    .bind(owner)
    .fetch_optional(db)
    .await?;
    Ok(present.is_some())
}

/// Whose sidekick `user` is, if it's one.
pub(crate) async fn owner_of(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
) -> ApiResult<Option<Uuid>> {
    let row: Option<(Option<Uuid>,)> = sqlx::query_as("SELECT agent_of FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row.and_then(|r| r.0))
}

async fn account_of(db: &PgPool, owner: UserId) -> ApiResult<Option<SidekickAccount>> {
    let row: Option<(Uuid, Option<String>, Option<i32>)> =
        sqlx::query_as("SELECT id, username, tag FROM users WHERE agent_of = $1")
            .bind(owner)
            .fetch_optional(db)
            .await?;
    let Some((user_id, username, tag)) = row else {
        return Ok(None);
    };
    let devices: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(Some(SidekickAccount {
        user_id,
        devices: devices.into_iter().map(|d| d.0).collect(),
        username,
        tag: tag.map(|t| t as u16),
    }))
}

/// `GET /v1/me/sidekick`: your server-side sidekick, if you've turned it on.
pub async fn mine(State(s): State<AppState>, user: AuthUser) -> ApiResult<Json<Option<SidekickAccount>>> {
    Ok(Json(account_of(&s.db, user.user_id).await?))
}

/// `POST /v1/me/sidekick`: turns on your server-side sidekick. Repeating it is
/// harmless. It isn't in any channel until you add it to one.
pub async fn enable(State(s): State<AppState>, user: AuthUser) -> ApiResult<Json<SidekickAccount>> {
    if s.sidekick_host_hash.is_none() {
        return Err(ApiError::forbidden("this server doesn't run sidekicks"));
    }
    let mut tx = s.db.begin().await?;
    let (is_agent, name): (bool, Option<String>) =
        sqlx::query_as("SELECT is_agent, sidekick_name FROM users WHERE id = $1 FOR UPDATE")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await?;
    if is_agent || user.is_guest {
        return Err(ApiError::forbidden("only members can have a sidekick"));
    }
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Sidekick".into());
    let existing: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE agent_of = $1")
        .bind(user.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if existing.is_none() {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, org_id, oidc_issuer, oidc_subject, display_name, is_agent, agent_of, dm_policy, onboarded)
             VALUES ($1, $2, 'anarchy:sidekick', $3, $4, true, $5, 'spaces', true)",
        )
        .bind(id)
        .bind(s.org_id)
        .bind(id.to_string())
        .bind(&name)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
        accounts::ensure_account(&mut tx, &s, id, &format!("{name} sidekick")).await?;
    }
    tx.commit().await?;
    Ok(Json(
        account_of(&s.db, user.user_id).await?.expect("just created"),
    ))
}

/// The sidekick host, recognised by its token (`ANARCHY_SIDEKICK_HOST_TOKEN`).
pub struct Host;

impl FromRequestParts<AppState> for Host {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthorized)?;
        let Some(want) = &s.sidekick_host_hash else {
            return Err(ApiError::not_found("this server doesn't run sidekicks"));
        };
        let got = Sha256::digest(token.as_bytes());
        // Compare every byte, so timing doesn't tell how much of a guess was right.
        let diff = got.iter().zip(want.iter()).fold(0u8, |d, (a, b)| d | (a ^ b));
        if diff != 0 {
            return Err(ApiError::unauthorized());
        }
        Ok(Host)
    }
}

/// `GET /v1/host/agents`: every sidekick the host should run.
pub async fn host_agents(State(s): State<AppState>, _host: Host) -> ApiResult<Json<Vec<HostedAgent>>> {
    let rows: Vec<(Uuid, Uuid, Option<String>)> = sqlx::query_as(
        "SELECT a.id, a.agent_of, o.sidekick_name FROM users a JOIN users o ON o.id = a.agent_of
         WHERE a.org_id = $1 ORDER BY a.created_at",
    )
    .bind(s.org_id)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(user_id, owner, name)| HostedAgent {
                user_id,
                owner,
                name: name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| "Sidekick".into()),
            })
            .collect(),
    ))
}

/// `POST /v1/host/agents/{user}/session`: a session for one sidekick.
pub async fn host_session(
    State(s): State<AppState>,
    _host: Host,
    Path(agent): Path<UserId>,
) -> ApiResult<Json<Session>> {
    let mut tx = s.db.begin().await?;
    if owner_of(&mut tx, agent).await?.is_none() {
        return Err(ApiError::not_found("no such sidekick"));
    }
    let (token, hash) = crate::auth::new_session_token();
    let expires_at_ms = now_ms() + HOST_SESSION_MS;
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))",
    )
    .bind(hash)
    .bind(agent)
    .bind(expires_at_ms as f64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(Session {
        token,
        user_id: agent,
        org_id: s.org_id,
        expires_at_ms,
        is_guest: false,
    }))
}

/// Sidekicks run for someone can't reshape channels (other agent accounts are separate).
pub(crate) async fn is_sidekick_device(db: &PgPool, dev: &AuthDevice) -> ApiResult<bool> {
    let (agent,): (bool,) = sqlx::query_as("SELECT agent_of IS NOT NULL FROM users WHERE id = $1")
        .bind(dev.user_id)
        .fetch_one(db)
        .await?;
    Ok(agent)
}
