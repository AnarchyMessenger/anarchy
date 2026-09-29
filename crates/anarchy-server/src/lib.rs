//! Anarchy server: gateway and delivery service.
//!
//! Stores ciphertext and routing metadata in Postgres. Every endpoint except
//! sign-in needs a session, and every channel endpoint needs the calling device
//! to be a member of that channel.

pub mod accounts;
pub mod auth;
pub mod email;
pub mod links;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anarchy_proto::{
    AppendRequest, AppendResponse, AuthConfig, Blob, ChannelId, CreateChannel, CreateInvite, DeviceId, Event,
    EventKind, EventsPage, GuestJoin, InboxItem, Invite, KeyPackageUpload, Member, OidcLogin, OrgId,
    RegisterDevice, Session,
};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

pub use auth::{AuthDevice, AuthUser, Oidc, OidcConfig};
pub use email::{EmailConfig, LogMailer, Mailer, SmtpMailer};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub struct Config {
    /// Sign-in with the organisation's identity provider. `None` if it has none.
    pub oidc: Option<OidcConfig>,
    /// Sign-in with a one-time code by email, for allowed domains. `None` turns it off.
    pub email: Option<EmailConfig>,
    /// This server hosts one organisation (self-hosted, single tenant).
    pub org_name: String,
    pub session_ttl: Duration,
    /// Let members invite guests (people without an account). Off by default.
    pub guests_enabled: bool,
    /// A public server: anyone may create an account (including anonymous ones)
    /// and there's no organisation-wide space. Off for company servers.
    pub open_signup: bool,
    /// Sent to clients for providers (Google) that want one from installed apps.
    pub oidc_client_secret: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub oidc: Option<Arc<Oidc>>,
    pub email: Option<Arc<EmailConfig>>,
    pub org_id: OrgId,
    pub org_name: String,
    pub session_ttl: Duration,
    pub guests_enabled: bool,
    pub open_signup: bool,
    pub oidc_client_secret: Option<String>,
    /// The organisation's space on a company server; everyone is a member.
    pub default_space: Option<Uuid>,
}

impl AppState {
    /// Runs migrations and ensures the organisation row exists.
    pub async fn new(db: PgPool, config: Config) -> Result<Self, sqlx::Error> {
        MIGRATOR.run(&db).await?;
        let (org_id,): (Uuid,) = sqlx::query_as(
            "INSERT INTO orgs (id, name) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        )
        .bind(Uuid::new_v4())
        .bind(&config.org_name)
        .fetch_one(&db)
        .await?;
        let default_space = if config.open_signup {
            None
        } else {
            Some(ensure_default_space(&db, org_id, &config.org_name).await?)
        };
        Ok(Self {
            db,
            oidc: config.oidc.map(|c| Arc::new(Oidc::new(c))),
            email: config.email.map(Arc::new),
            org_id,
            org_name: config.org_name,
            session_ttl: config.session_ttl,
            // Guests belong to the organisation's space; an open server has none.
            guests_enabled: config.guests_enabled && !config.open_signup,
            open_signup: config.open_signup,
            oidc_client_secret: config.oidc_client_secret,
            default_space,
        })
    }
}

/// Creates the organisation's space and moves everything from before spaces
/// existed into it: every account, and every channel that isn't a DM.
async fn ensure_default_space(db: &PgPool, org_id: Uuid, name: &str) -> Result<Uuid, sqlx::Error> {
    let mut tx = db.begin().await?;
    let existing: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM spaces WHERE org_id = $1 AND is_default")
        .bind(org_id)
        .fetch_optional(&mut *tx)
        .await?;
    let id = match existing {
        Some((id,)) => id,
        None => {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO spaces (id, org_id, name, kind, is_default) VALUES ($1, $2, $3, 'company', true)")
                .bind(id)
                .bind(org_id)
                .bind(name)
                .execute(&mut *tx)
                .await?;
            id
        }
    };
    sqlx::query(
        "INSERT INTO space_members (space_id, user_id, role)
         SELECT $1, id, 'member' FROM users WHERE org_id = $2 ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(org_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE channels SET space_id = $1 WHERE org_id = $2 AND space_id IS NULL AND kind = 'channel'",
    )
    .bind(id)
    .bind(org_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/oidc", post(login))
        .route("/v1/auth/guest", post(join_as_guest))
        .route("/v1/auth/email/start", post(email::start))
        .route("/v1/auth/email/verify", post(email::verify))
        .route("/v1/auth/anonymous", post(accounts::anonymous))
        .route("/v1/me", get(accounts::me).put(accounts::update_me))
        .route("/v1/directory", get(accounts::directory))
        .route(
            "/v1/spaces",
            post(accounts::create_space).get(accounts::my_spaces),
        )
        .route("/v1/spaces/join", post(accounts::join_space))
        .route("/v1/spaces/{space}/invites", post(accounts::create_space_invite))
        .route("/v1/dms", post(accounts::start_dm))
        .route("/v1/invites", post(create_invite))
        .route("/v1/invites/{invite}/revoke", post(revoke_invite))
        .route("/v1/devices", post(register_device).get(my_devices))
        .route("/v1/devices/{device}/revoke", post(revoke_device))
        .route("/v1/channels", post(create_channel).get(accounts::my_channels))
        .route("/v1/channels/{channel}/events", post(append).get(events))
        .route("/v1/channels/{channel}/members", get(members))
        .route(
            "/v1/channels/{channel}/blobs",
            post(upload_blob).layer(axum::extract::DefaultBodyLimit::max(MAX_BLOB + 1024)),
        )
        .route("/v1/channels/{channel}/blobs/{blob}", get(download_blob))
        .route(
            "/v1/channels/{channel}/pay_links",
            post(links::create).get(links::list),
        )
        .route(
            "/v1/channels/{channel}/pay_links/{link}",
            axum::routing::put(links::update),
        )
        .route(
            "/v1/channels/{channel}/pay_links/{link}/revoke",
            post(links::revoke),
        )
        .route("/p/{link}", get(links::public_page))
        .route("/i/{code}", get(links::invite_page))
        .route("/p/{link}/sealed", get(links::public_sealed))
        .route("/p/{link}/paid", post(links::public_paid))
        .route("/pay-assets/pay.js", get(links::public_js))
        .route("/pay-assets/pay.css", get(links::public_css))
        .route("/v1/devices/{device}/key_packages", post(upload_key_packages))
        .route("/v1/devices/{device}/key_packages/claim", post(claim_key_package))
        .route("/v1/devices/{device}/inbox", post(push_inbox).get(drain_inbox))
        .with_state(state)
}

// ---------- errors ----------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "sign in required")
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }
    pub fn too_many(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message)
    }
    pub fn unauthorized_msg(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("database error: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(anarchy_proto::ApiError { error: self.message })).into_response()
    }
}

pub(crate) type ApiResult<T> = Result<T, ApiError>;

/// Issues a session for `user_id`. `cap_ms` shortens it (guests end with their invite).
pub(crate) async fn create_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    s: &AppState,
    user_id: Uuid,
    cap_ms: Option<u64>,
    is_guest: bool,
) -> ApiResult<Session> {
    let (token, hash) = auth::new_session_token();
    let mut expires_at_ms = now_ms() + s.session_ttl.as_millis() as u64;
    if let Some(cap) = cap_ms {
        expires_at_ms = expires_at_ms.min(cap);
    }
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
        is_guest,
    })
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- sign-in and devices ----------

async fn login(State(s): State<AppState>, Json(req): Json<OidcLogin>) -> ApiResult<Json<Session>> {
    let oidc = s
        .oidc
        .as_ref()
        .ok_or_else(|| ApiError::forbidden("this workspace doesn't use an identity provider"))?;
    let claims = oidc.verify(&req.id_token).await?;
    let mut tx = s.db.begin().await?;
    let (user_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO users (id, org_id, oidc_issuer, oidc_subject, display_name, email)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (oidc_issuer, oidc_subject)
         DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(s.org_id)
    .bind(oidc.issuer())
    .bind(&claims.sub)
    .bind(&claims.name)
    .bind(&claims.email)
    .fetch_one(&mut *tx)
    .await?;
    let hint = claims.name.clone().or(claims.email.clone()).unwrap_or_default();
    accounts::ensure_account(&mut tx, &s, user_id, &hint).await?;
    let session = create_session(&mut tx, &s, user_id, None, false).await?;
    tx.commit().await?;
    Ok(Json(session))
}

async fn auth_config(State(s): State<AppState>) -> Json<AuthConfig> {
    Json(AuthConfig {
        org_name: s.org_name.clone(),
        issuer: s.oidc.as_ref().map(|o| o.issuer().to_owned()),
        client_id: s.oidc.as_ref().map(|o| o.audience().to_owned()),
        email_enabled: s.email.is_some(),
        guests_enabled: s.guests_enabled,
        open_signup: s.open_signup,
        anonymous_enabled: s.open_signup,
        client_secret: s.oidc_client_secret.clone(),
    })
}

async fn my_devices(
    State(s): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<anarchy_proto::DeviceSummary>>> {
    let rows: Vec<(Uuid, f64, bool)> = sqlx::query_as(
        "SELECT id, extract(epoch FROM created_at)::float8 * 1000, revoked_at IS NOT NULL
         FROM devices WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user.user_id)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(device_id, created, revoked)| anarchy_proto::DeviceSummary {
                device_id,
                created_at_ms: created as u64,
                revoked,
            })
            .collect(),
    ))
}

/// Creates a guest account from an invite code. The guest's access, and every
/// session it gets, ends when the invite expires.
async fn join_as_guest(State(s): State<AppState>, Json(req): Json<GuestJoin>) -> ApiResult<Json<Session>> {
    if !s.guests_enabled {
        return Err(ApiError::forbidden("this workspace doesn't allow guests"));
    }
    let name = req.display_name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(ApiError::bad_request("display name must be 1 to 64 characters"));
    }
    let mut tx = s.db.begin().await?;
    let invite: Option<(Uuid, f64)> = sqlx::query_as(
        "SELECT id, extract(epoch FROM expires_at)::float8 FROM invites
         WHERE code_hash = $1 AND org_id = $2 AND space_id IS NULL AND revoked_at IS NULL
           AND expires_at > now() AND uses < max_uses
         FOR UPDATE",
    )
    .bind(auth::hash_invite_code(&req.invite_code))
    .bind(s.org_id)
    .fetch_optional(&mut *tx)
    .await?;
    // One message for unknown, used-up, revoked and expired codes: no hints for guessing.
    let (invite_id, invite_expiry) =
        invite.ok_or_else(|| ApiError::forbidden("this invite code isn't valid; ask for a new one"))?;
    sqlx::query("UPDATE invites SET uses = uses + 1 WHERE id = $1")
        .bind(invite_id)
        .execute(&mut *tx)
        .await?;

    let user_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, org_id, oidc_issuer, oidc_subject, display_name, is_guest, expires_at, invite_id)
         VALUES ($1, $2, 'anarchy:guest', $3, $4, true, to_timestamp($5), $6)",
    )
    .bind(user_id)
    .bind(s.org_id)
    .bind(user_id.to_string())
    .bind(name)
    .bind(invite_expiry)
    .bind(invite_id)
    .execute(&mut *tx)
    .await?;
    accounts::ensure_account(&mut tx, &s, user_id, name).await?;

    let session = create_session(&mut tx, &s, user_id, Some((invite_expiry * 1000.0) as u64), true).await?;
    tx.commit().await?;
    Ok(Json(session))
}

pub(crate) const MAX_INVITE_SECS: u64 = 30 * 24 * 3600;

async fn create_invite(
    State(s): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateInvite>,
) -> ApiResult<Json<Invite>> {
    if !s.guests_enabled {
        return Err(ApiError::forbidden("this workspace doesn't allow guests"));
    }
    if user.is_guest {
        return Err(ApiError::forbidden("guests can't invite other guests"));
    }
    if !(60..=MAX_INVITE_SECS).contains(&req.expires_in_secs) {
        return Err(ApiError::bad_request("invites last between 1 minute and 30 days"));
    }
    if !(1..=1000).contains(&req.max_uses) {
        return Err(ApiError::bad_request("an invite can be used 1 to 1000 times"));
    }
    let (code, hash) = auth::new_invite_code();
    let id = Uuid::new_v4();
    let expires_at_ms = now_ms() + req.expires_in_secs * 1000;
    sqlx::query(
        "INSERT INTO invites (id, org_id, code_hash, created_by, expires_at, max_uses)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6)",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(hash)
    .bind(user.user_id)
    .bind(expires_at_ms as f64)
    .bind(req.max_uses as i32)
    .execute(&s.db)
    .await?;
    Ok(Json(Invite {
        id,
        code,
        expires_at_ms,
        max_uses: req.max_uses,
    }))
}

/// Revokes an invite. Guests who already joined through it keep access until it
/// would have expired; revoke their devices to cut them off sooner.
async fn revoke_invite(
    State(s): State<AppState>,
    user: AuthUser,
    Path(invite): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let updated = sqlx::query(
        "UPDATE invites SET revoked_at = now() WHERE id = $1 AND created_by = $2 AND revoked_at IS NULL",
    )
    .bind(invite)
    .bind(user.user_id)
    .execute(&s.db)
    .await?
    .rows_affected();
    if updated == 0 {
        return Err(ApiError::not_found("no such active invite"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn register_device(
    State(s): State<AppState>,
    user: AuthUser,
    Json(req): Json<RegisterDevice>,
) -> ApiResult<StatusCode> {
    let inserted = sqlx::query(
        "INSERT INTO devices (id, user_id, signature_key) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(req.device_id)
    .bind(user.user_id)
    .bind(&req.signature_key.0)
    .execute(&s.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        // Re-registering the same device is fine; claiming someone else's ID is not.
        let (owner, key): (Uuid, Vec<u8>) =
            sqlx::query_as("SELECT user_id, signature_key FROM devices WHERE id = $1")
                .bind(req.device_id)
                .fetch_one(&s.db)
                .await?;
        if owner != user.user_id || key != req.signature_key.0 {
            return Err(ApiError::conflict("device ID already registered"));
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Revokes one of the caller's own devices (lost or retired). It can no longer
/// authenticate and drops out of every channel's member list; remaining members
/// then commit its removal from the MLS groups.
async fn revoke_device(
    State(s): State<AppState>,
    user: AuthUser,
    Path(device): Path<DeviceId>,
) -> ApiResult<StatusCode> {
    let updated = sqlx::query(
        "UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(device)
    .bind(user.user_id)
    .execute(&s.db)
    .await?
    .rows_affected();
    if updated == 0 {
        return Err(ApiError::not_found("no such active device"));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------- channels ----------

/// A current member: added and not removed since.
async fn is_member(db: &PgPool, channel: ChannelId, device: DeviceId) -> ApiResult<bool> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM channel_members WHERE channel_id = $1 AND device_id = $2 AND removed_seq IS NULL",
    )
    .bind(channel)
    .bind(device)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// Non-members get 404, so the API doesn't reveal which channels exist.
pub(crate) async fn require_member(db: &PgPool, channel: ChannelId, device: DeviceId) -> ApiResult<()> {
    if is_member(db, channel, device).await? {
        Ok(())
    } else {
        Err(ApiError::not_found("no such channel"))
    }
}

async fn create_channel(
    State(s): State<AppState>,
    dev: AuthDevice,
    Json(req): Json<CreateChannel>,
) -> ApiResult<StatusCode> {
    let mut tx = s.db.begin().await?;
    let created = if req.personal {
        // Only this person's devices can ever be added (see `append`).
        sqlx::query(
            "INSERT INTO channels (id, org_id, created_by_device, kind, dm_a) VALUES ($1, $2, $3, 'personal', $4)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(req.channel)
        .bind(dev.org_id)
        .bind(dev.device_id)
        .bind(dev.user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    } else {
        let space = req
            .space
            .or(s.default_space)
            .ok_or_else(|| ApiError::bad_request("say which space the channel is in"))?;
        accounts::require_space_member(&s.db, space, dev.user_id).await?;
        sqlx::query(
            "INSERT INTO channels (id, org_id, created_by_device, space_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(req.channel)
        .bind(dev.org_id)
        .bind(dev.device_id)
        .bind(space)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    if created == 0 {
        return Err(ApiError::conflict("channel already exists"));
    }
    sqlx::query("INSERT INTO channel_members (channel_id, device_id, added_seq) VALUES ($1, $2, 0)")
        .bind(req.channel)
        .bind(dev.device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

async fn append(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
    Json(req): Json<AppendRequest>,
) -> ApiResult<Json<AppendResponse>> {
    if (!req.adds.is_empty() || !req.removes.is_empty()) && req.kind != EventKind::Commit {
        return Err(ApiError::bad_request("only commits can add or remove devices"));
    }
    if req.removes.contains(&dev.device_id) {
        return Err(ApiError::bad_request(
            "a device can't remove itself; another member must",
        ));
    }
    let mut tx = s.db.begin().await?;
    // Lock the channel row: appends to one channel are serialised, which is what
    // gives every member the same order and settles concurrent commits.
    type ChannelRow = (i64, i64, Option<Uuid>, Option<Uuid>, Option<Uuid>);
    let row: Option<ChannelRow> =
        sqlx::query_as("SELECT epoch, head, space_id, dm_a, dm_b FROM channels WHERE id = $1 FOR UPDATE")
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((epoch, head, space, dm_a, dm_b)) = row else {
        return Err(ApiError::not_found("no such channel"));
    };
    let member: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM channel_members WHERE channel_id = $1 AND device_id = $2 AND removed_seq IS NULL",
    )
    .bind(channel)
    .bind(dev.device_id)
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(ApiError::not_found("no such channel"));
    }

    // A retry of an accepted append returns the original result, even if the epoch moved since.
    let seen: Option<(i64,)> =
        sqlx::query_as("SELECT seq FROM channel_events WHERE channel_id = $1 AND idempotency_key = $2")
            .bind(channel)
            .bind(req.idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((seq,)) = seen {
        return Ok(Json(AppendResponse::Accepted { seq: seq as u64 }));
    }
    if req.epoch as i64 != epoch {
        return Ok(Json(AppendResponse::StaleEpoch {
            current_epoch: epoch as u64,
        }));
    }

    let seq = head + 1;
    let kind = match req.kind {
        EventKind::Commit => "commit",
        EventKind::Application => "application",
    };
    sqlx::query(
        "INSERT INTO channel_events (channel_id, seq, epoch, kind, sender_device, ts_ms, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(channel)
    .bind(seq)
    .bind(epoch)
    .bind(kind)
    .bind(dev.device_id)
    .bind(now_ms() as i64)
    .bind(req.idempotency_key)
    .bind(&req.payload.0)
    .execute(&mut *tx)
    .await?;

    for added in &req.adds {
        // Who may be added: members of the channel's space, or for a direct
        // conversation, the two people in it (any of their devices).
        let owner: Option<(Uuid,)> = sqlx::query_as(
            "SELECT u.id FROM devices d JOIN users u ON u.id = d.user_id
             WHERE d.id = $1 AND u.org_id = $2 AND d.revoked_at IS NULL
               AND (u.expires_at IS NULL OR u.expires_at > now())",
        )
        .bind(added)
        .bind(dev.org_id)
        .fetch_optional(&mut *tx)
        .await?;
        let allowed = match (owner, space) {
            (None, _) => false,
            (Some((user,)), Some(space)) => sqlx::query_as::<_, (i32,)>(
                "SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2",
            )
            .bind(space)
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?
            .is_some(),
            (Some((user,)), None) => Some(user) == dm_a || Some(user) == dm_b,
        };
        if !allowed {
            return Err(ApiError::bad_request(format!(
                "device {added} can't be added here: its owner isn't in this space or conversation"
            )));
        }
        // Re-adding a removed device reactivates it. It can then fetch the
        // ciphertext sent while it was out, but has no keys for those epochs.
        sqlx::query(
            "INSERT INTO channel_members (channel_id, device_id, added_seq) VALUES ($1, $2, $3)
             ON CONFLICT (channel_id, device_id) DO UPDATE SET added_seq = EXCLUDED.added_seq, removed_seq = NULL",
        )
        .bind(channel)
        .bind(added)
        .bind(seq)
        .execute(&mut *tx)
        .await?;
    }

    for removed in &req.removes {
        let updated = sqlx::query(
            "UPDATE channel_members SET removed_seq = $3
             WHERE channel_id = $1 AND device_id = $2 AND removed_seq IS NULL",
        )
        .bind(channel)
        .bind(removed)
        .bind(seq)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(ApiError::bad_request(format!(
                "device {removed} is not a member of this channel"
            )));
        }
    }

    let new_epoch = if req.kind == EventKind::Commit {
        epoch + 1
    } else {
        epoch
    };
    sqlx::query("UPDATE channels SET head = $2, epoch = $3 WHERE id = $1")
        .bind(channel)
        .bind(seq)
        .bind(new_epoch)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(AppendResponse::Accepted { seq: seq as u64 }))
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    500
}

async fn events(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<EventsPage>> {
    // Current members read everything; a removed device reads up to the commit
    // that removed it, so it can learn it was removed, and nothing after.
    let access: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT removed_seq FROM channel_members WHERE channel_id = $1 AND device_id = $2")
            .bind(channel)
            .bind(dev.device_id)
            .fetch_optional(&s.db)
            .await?;
    let Some((removed_seq,)) = access else {
        return Err(ApiError::not_found("no such channel"));
    };
    let visible_to = removed_seq.unwrap_or(i64::MAX);
    let rows: Vec<(i64, i64, String, Uuid, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, epoch, kind, sender_device, ts_ms, payload FROM channel_events
         WHERE channel_id = $1 AND seq > $2 AND seq <= $4 ORDER BY seq LIMIT $3",
    )
    .bind(channel)
    .bind(q.after as i64)
    .bind(q.limit.clamp(1, 1000) as i64)
    .bind(visible_to)
    .fetch_all(&s.db)
    .await?;
    let (head,): (i64,) = sqlx::query_as("SELECT head FROM channels WHERE id = $1")
        .bind(channel)
        .fetch_one(&s.db)
        .await?;
    let head = head.min(visible_to);
    let events = rows
        .into_iter()
        .map(|(seq, epoch, kind, sender_device, ts_ms, payload)| Event {
            seq: seq as u64,
            epoch: epoch as u64,
            kind: if kind == "commit" {
                EventKind::Commit
            } else {
                EventKind::Application
            },
            sender_device,
            ts_ms: ts_ms as u64,
            payload: Blob(payload),
        })
        .collect();
    Ok(Json(EventsPage {
        events,
        head: head as u64,
    }))
}

async fn members(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
) -> ApiResult<Json<Vec<Member>>> {
    require_member(&s.db, channel, dev.device_id).await?;
    type Row = (
        Uuid,
        Uuid,
        Option<String>,
        bool,
        Option<String>,
        Option<i32>,
        bool,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT d.id, d.user_id, u.display_name, u.is_guest, u.username, u.tag, u.is_agent FROM channel_members m
         JOIN devices d ON d.id = m.device_id JOIN users u ON u.id = d.user_id
         WHERE m.channel_id = $1 AND m.removed_seq IS NULL AND d.revoked_at IS NULL
           AND (u.expires_at IS NULL OR u.expires_at > now())
         ORDER BY m.added_seq, d.id",
    )
    .bind(channel)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(
                |(device_id, user_id, display_name, is_guest, username, tag, is_agent)| Member {
                    device_id,
                    user_id,
                    display_name,
                    is_guest,
                    username,
                    tag: tag.map(|t| t as u16),
                    is_agent,
                },
            )
            .collect(),
    ))
}

// ---------- file chunks ----------

/// One sealed chunk: 4 MiB of plaintext plus the AEAD tag.
pub const MAX_BLOB: usize = 4 * 1024 * 1024 + 64;

async fn upload_blob(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
    body: axum::body::Bytes,
) -> ApiResult<Json<anarchy_proto::BlobRef>> {
    require_member(&s.db, channel, dev.device_id).await?;
    if body.is_empty() || body.len() > MAX_BLOB {
        return Err(ApiError::bad_request("a chunk is 1 byte to 4 MiB"));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO blobs (id, channel_id, size, data, created_by_device) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(channel)
    .bind(body.len() as i32)
    .bind(body.as_ref())
    .bind(dev.device_id)
    .execute(&s.db)
    .await?;
    Ok(Json(anarchy_proto::BlobRef { id }))
}

async fn download_blob(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path((channel, blob)): Path<(ChannelId, Uuid)>,
) -> ApiResult<Response> {
    // Current members only: someone removed keeps any key they saw, but not the bytes.
    require_member(&s.db, channel, dev.device_id).await?;
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT data FROM blobs WHERE id = $1 AND channel_id = $2")
        .bind(blob)
        .bind(channel)
        .fetch_optional(&s.db)
        .await?;
    let (data,) = row.ok_or_else(|| ApiError::not_found("no such file"))?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        data,
    )
        .into_response())
}

// ---------- key packages and invites ----------

async fn upload_key_packages(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(device): Path<DeviceId>,
    Json(req): Json<KeyPackageUpload>,
) -> ApiResult<StatusCode> {
    if device != dev.device_id {
        return Err(ApiError::forbidden("devices publish only their own key packages"));
    }
    for kp in req.key_packages {
        sqlx::query("INSERT INTO key_packages (device_id, data) VALUES ($1, $2)")
            .bind(device)
            .bind(kp.0)
            .execute(&s.db)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Key packages are single-use in MLS, so claiming one deletes it.
async fn claim_key_package(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(device): Path<DeviceId>,
) -> ApiResult<Json<Blob>> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "DELETE FROM key_packages WHERE id = (
            SELECT k.id FROM key_packages k
            JOIN devices d ON d.id = k.device_id JOIN users u ON u.id = d.user_id
            WHERE k.device_id = $1 AND u.org_id = $2 AND d.revoked_at IS NULL
            ORDER BY k.id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING data",
    )
    .bind(device)
    .bind(dev.org_id)
    .fetch_optional(&s.db)
    .await?;
    row.map(|(data,)| Json(Blob(data)))
        .ok_or_else(|| ApiError::not_found("no key package available"))
}

async fn push_inbox(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(device): Path<DeviceId>,
    Json(item): Json<InboxItem>,
) -> ApiResult<StatusCode> {
    // Only a member may send a Welcome, and only to a device already added to the channel.
    require_member(&s.db, item.channel, dev.device_id).await?;
    if !is_member(&s.db, item.channel, device).await? {
        return Err(ApiError::forbidden("device has not been added to this channel"));
    }
    sqlx::query("INSERT INTO inbox (device_id, channel_id, welcome) VALUES ($1, $2, $3)")
        .bind(device)
        .bind(item.channel)
        .bind(item.welcome.0)
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn drain_inbox(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(device): Path<DeviceId>,
) -> ApiResult<Json<Vec<InboxItem>>> {
    if device != dev.device_id {
        return Err(ApiError::forbidden("devices read only their own inbox"));
    }
    let rows: Vec<(Uuid, Vec<u8>)> =
        sqlx::query_as("DELETE FROM inbox WHERE device_id = $1 RETURNING channel_id, welcome")
            .bind(device)
            .fetch_all(&s.db)
            .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(channel, welcome)| InboxItem {
                channel,
                welcome: Blob(welcome),
            })
            .collect(),
    ))
}
