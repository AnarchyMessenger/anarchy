//! Pay-this-invoice links: a page someone without an account opens from an
//! email or text (DESKS-PLAN.md, "The client side").
//!
//! A desk member's device encrypts the page's content (who's billing whom, the
//! amount, how to pay) with a fresh key and uploads only the ciphertext. The
//! key is in the link's `#fragment`, which browsers don't send, so the server
//! stores bytes it can't read. What it does learn: that a link exists for a
//! desk, when it's opened, and when someone presses "I've paid".
//!
//! The honest limit, also stated in the docs: the page's script comes from this
//! server, so a server that turned hostile could serve a script that reads the
//! fragment. Encryption here protects against a leaked database or backup, not
//! against the operator.

use anarchy_proto::{ChannelId, CreatePayLink, PayLinkCreated, PayLinkStatus, PublicPayLink, UpdatePayLink};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

use crate::auth::AuthDevice;
use crate::{ApiError, ApiResult, AppState, now_ms, require_member};

/// The sealed page: a few hundred bytes of JSON in practice.
const MAX_SEALED: usize = 16 * 1024;
const MIN_LIFETIME_MS: u64 = 60 * 60 * 1000;
const MAX_LIFETIME_MS: u64 = 180 * 24 * 60 * 60 * 1000;

fn decode_sealed(sealed: &str) -> ApiResult<Vec<u8>> {
    let bytes = STANDARD
        .decode(sealed)
        .map_err(|_| ApiError::bad_request("sealed must be base64"))?;
    // 12-byte nonce plus a 16-byte tag at least.
    if bytes.len() < 28 || bytes.len() > MAX_SEALED {
        return Err(ApiError::bad_request("a link's content is 28 bytes to 16 KiB"));
    }
    Ok(bytes)
}

fn new_id() -> ApiResult<String> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|_| ApiError::unavailable("no randomness"))?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

pub async fn create(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
    Json(req): Json<CreatePayLink>,
) -> ApiResult<Json<PayLinkCreated>> {
    require_member(&s.db, channel, dev.device_id).await?;
    let sealed = decode_sealed(&req.sealed)?;
    let now = now_ms();
    if req.expires_at_ms < now + MIN_LIFETIME_MS || req.expires_at_ms > now + MAX_LIFETIME_MS {
        return Err(ApiError::bad_request("a link lasts between 1 hour and 180 days"));
    }
    let id = new_id()?;
    sqlx::query(
        "INSERT INTO pay_links (id, channel_id, created_by_device, sealed, expires_at)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))",
    )
    .bind(&id)
    .bind(channel)
    .bind(dev.device_id)
    .bind(sealed)
    .bind(req.expires_at_ms as f64)
    .execute(&s.db)
    .await?;
    Ok(Json(PayLinkCreated { id }))
}

type StatusRow = (String, f64, bool, i32, Option<f64>, Option<f64>);

pub async fn list(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
) -> ApiResult<Json<Vec<PayLinkStatus>>> {
    require_member(&s.db, channel, dev.device_id).await?;
    let rows: Vec<StatusRow> = sqlx::query_as(
        "SELECT id, extract(epoch FROM expires_at)::float8 * 1000, revoked_at IS NOT NULL, views,
                extract(epoch FROM last_viewed_at)::float8 * 1000,
                extract(epoch FROM claimed_paid_at)::float8 * 1000
         FROM pay_links WHERE channel_id = $1 ORDER BY created_at",
    )
    .bind(channel)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, exp, revoked, views, viewed, claimed)| PayLinkStatus {
                id,
                expires_at_ms: exp as u64,
                revoked,
                views: views.max(0) as u32,
                last_viewed_at_ms: viewed.map(|v| v as u64),
                claimed_paid_at_ms: claimed.map(|v| v as u64),
            })
            .collect(),
    ))
}

pub async fn update(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path((channel, id)): Path<(ChannelId, String)>,
    Json(req): Json<UpdatePayLink>,
) -> ApiResult<StatusCode> {
    require_member(&s.db, channel, dev.device_id).await?;
    let sealed = decode_sealed(&req.sealed)?;
    let done = sqlx::query("UPDATE pay_links SET sealed = $1 WHERE id = $2 AND channel_id = $3")
        .bind(sealed)
        .bind(&id)
        .bind(channel)
        .execute(&s.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found("no such link"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path((channel, id)): Path<(ChannelId, String)>,
) -> ApiResult<StatusCode> {
    require_member(&s.db, channel, dev.device_id).await?;
    let done = sqlx::query(
        "UPDATE pay_links SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND channel_id = $2",
    )
    .bind(&id)
    .bind(channel)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found("no such link"));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------- public, no account ----------

const ACTIVE: &str = "id = $1 AND revoked_at IS NULL AND expires_at > now()";

pub async fn public_sealed(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let row: Option<(Vec<u8>, Option<f64>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE pay_links SET views = views + 1, last_viewed_at = now() WHERE {ACTIVE}
         RETURNING sealed, extract(epoch FROM claimed_paid_at)::float8 * 1000"
    )))
    .bind(&id)
    .fetch_optional(&s.db)
    .await?;
    let (sealed, claimed) = row.ok_or_else(|| ApiError::not_found("this link has ended"))?;
    let body = PublicPayLink {
        sealed: STANDARD.encode(sealed),
        claimed_paid_at_ms: claimed.map(|v| v as u64),
    };
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

/// "I've paid": recorded once, shown to the desk as a claim to check.
pub async fn public_paid(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let done = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE pay_links SET claimed_paid_at = coalesce(claimed_paid_at, now()) WHERE {ACTIVE}"
    )))
    .bind(&id)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found("this link has ended"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Same page for every id (it learns everything from the API and the fragment).
const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; \
     img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn page(content_type: &'static str, body: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_SECURITY_POLICY, PAGE_CSP),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::HeaderName::from_static("x-robots-tag"),
                "noindex, nofollow",
            ),
        ],
        body,
    )
        .into_response()
}

pub async fn public_page(Path(_id): Path<String>) -> Response {
    page("text/html; charset=utf-8", include_str!("../static/pay.html"))
}

pub async fn public_js() -> Response {
    page("text/javascript; charset=utf-8", include_str!("../static/pay.js"))
}

pub async fn public_css() -> Response {
    page("text/css; charset=utf-8", include_str!("../static/pay.css"))
}

/// What an invite link (`/i/{code}`) opens in a browser: how to use it in the app.
/// The code stays in the address; the page never reads it.
pub async fn invite_page(Path(_code): Path<String>) -> Response {
    page("text/html; charset=utf-8", include_str!("../static/invite.html"))
}
