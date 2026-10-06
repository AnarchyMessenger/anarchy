//! Linking a phone to an account (D42).
//!
//! 1. The desktop asks for an offer and shows its secret as a QR code.
//! 2. The phone scans it and claims the offer with a label ("Pixel 8"); it gets
//!    a ticket back, nothing else.
//! 3. The desktop shows the label and the person approves (or ends it).
//! 4. The phone collects a session with its ticket, once.
//!
//! Step 3 is the point: a photo of the code alone doesn't sign anyone in.
//! Offers last ten minutes, a person has at most three open, and only hashes of
//! the secret and the ticket are stored.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use uuid::Uuid;

use anarchy_proto::{LinkClaim, LinkOffer, LinkStatus, LinkTicket, Session};

use crate::auth::{AuthUser, hash_token, new_session_token};
use crate::{ApiError, ApiResult, AppState, create_session, now_ms};

const OFFER_TTL_MS: u64 = 10 * 60 * 1000;
const OPEN_OFFERS: i64 = 3;

/// `POST /v1/devices/links`: a new offer, for the signed-in person.
pub async fn offer(State(s): State<AppState>, user: AuthUser) -> ApiResult<Json<LinkOffer>> {
    if user.is_guest {
        return Err(ApiError::forbidden("guests can't link other devices"));
    }
    let mut tx = s.db.begin().await?;
    // Serialise per person so the cap holds.
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    let (open,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM device_links WHERE user_id = $1 AND state IN ('open', 'claimed', 'approved') AND expires_at > now()",
    )
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if open >= OPEN_OFFERS {
        return Err(ApiError::too_many("finish or end the links you've started first"));
    }
    let (secret, hash) = new_session_token();
    let id = Uuid::new_v4();
    let expires_at_ms = now_ms() + OFFER_TTL_MS;
    sqlx::query(
        "INSERT INTO device_links (id, user_id, secret_hash, expires_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))",
    )
    .bind(id)
    .bind(user.user_id)
    .bind(hash)
    .bind(expires_at_ms as f64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(LinkOffer {
        id,
        secret,
        expires_at_ms,
    }))
}

/// `GET /v1/devices/links/{id}`: the desktop watching its offer.
pub async fn status(
    State(s): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<LinkStatus>> {
    let row: Option<(String, Option<String>, f64, bool)> = sqlx::query_as(
        "SELECT state, label, (extract(epoch FROM expires_at) * 1000)::float8, expires_at <= now()
         FROM device_links WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_optional(&s.db)
    .await?;
    let (state, label, expires, expired) = row.ok_or_else(|| ApiError::not_found("no such link"))?;
    let state = if expired && state != "done" {
        "ended".to_string()
    } else {
        state
    };
    Ok(Json(LinkStatus {
        state,
        label,
        expires_at_ms: expires as u64,
    }))
}

/// `POST /v1/devices/links/{id}/approve`: yes, that phone is mine.
pub async fn approve(
    State(s): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let done = sqlx::query(
        "UPDATE device_links SET state = 'approved'
         WHERE id = $1 AND user_id = $2 AND state = 'claimed' AND expires_at > now()",
    )
    .bind(id)
    .bind(user.user_id)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::conflict("there's no phone waiting on this link"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /v1/devices/links/{id}/end`: cancel an offer, or turn a phone away.
pub async fn end(State(s): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    sqlx::query("UPDATE device_links SET state = 'ended' WHERE id = $1 AND user_id = $2 AND state <> 'done'")
        .bind(id)
        .bind(user.user_id)
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /v1/devices/links/claim`: the phone, with the scanned secret. Unsigned.
pub async fn claim(State(s): State<AppState>, Json(req): Json<LinkClaim>) -> ApiResult<Json<LinkTicket>> {
    let label: String = req.label.trim().chars().take(40).collect();
    if label.is_empty() {
        return Err(ApiError::bad_request("say what this device is called"));
    }
    let (ticket, ticket_hash) = new_session_token();
    // One claim per offer: a second phone with the same code gets nothing.
    let done = sqlx::query(
        "UPDATE device_links SET state = 'claimed', label = $2, ticket_hash = $3
         WHERE secret_hash = $1 AND state = 'open' AND expires_at > now()",
    )
    .bind(hash_token(&req.secret))
    .bind(&label)
    .bind(ticket_hash)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found(
            "this code has been used or has ended; make a new one",
        ));
    }
    Ok(Json(LinkTicket { ticket }))
}

/// `POST /v1/devices/links/collect`: the phone, once approved, gets its session.
/// 202 while the desktop hasn't answered yet.
pub async fn collect(
    State(s): State<AppState>,
    Json(req): Json<LinkTicket>,
) -> ApiResult<(StatusCode, Json<Option<Session>>)> {
    let mut tx = s.db.begin().await?;
    let row: Option<(String, Uuid, bool)> = sqlx::query_as(
        "SELECT state, user_id, expires_at <= now() FROM device_links WHERE ticket_hash = $1 FOR UPDATE",
    )
    .bind(hash_token(&req.ticket))
    .fetch_optional(&mut *tx)
    .await?;
    let Some((state, user_id, expired)) = row else {
        return Err(ApiError::not_found("unknown ticket"));
    };
    match state.as_str() {
        "claimed" if !expired => return Ok((StatusCode::ACCEPTED, Json(None))),
        "approved" => {}
        _ => return Err(ApiError::forbidden("this link was turned down or has ended")),
    }
    sqlx::query("UPDATE device_links SET state = 'done' WHERE ticket_hash = $1")
        .bind(hash_token(&req.ticket))
        .execute(&mut *tx)
        .await?;
    let session = create_session(&mut tx, &s, user_id, None, false).await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(Some(session))))
}
