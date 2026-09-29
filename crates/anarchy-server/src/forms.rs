//! Intake forms: a public page someone fills in without an account (see
//! `anarchy_core::intake` for the encryption). The server stores the sealed
//! definition and sealed answers; it learns that a form exists, when answers
//! arrive and how big they are, never what they say.

use anarchy_proto::{
    ChannelId, CreateForm, FormSubmission, PayLinkCreated, PublicPayLink, SubmitForm, UpdatePayLink,
};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::auth::AuthDevice;
use crate::links::{MIN_LIFETIME_MS, decode_sealed, new_id, page};
use crate::{ApiError, ApiResult, AppState, now_ms, require_member};

const MAX_LIFETIME_MS: u64 = 366 * 24 * 60 * 60 * 1000;
/// Answers waiting to be imported, per form. A full form refuses new answers
/// until a member's device picks them up, which bounds what a flood can store.
const MAX_PENDING: i64 = 200;
const MAX_ANSWER: usize = 32 * 1024;

pub async fn create(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path(channel): Path<ChannelId>,
    Json(req): Json<CreateForm>,
) -> ApiResult<Json<PayLinkCreated>> {
    require_member(&s.db, channel, dev.device_id).await?;
    let sealed = decode_sealed(&req.sealed)?;
    let now = now_ms();
    if req.expires_at_ms < now + MIN_LIFETIME_MS || req.expires_at_ms > now + MAX_LIFETIME_MS {
        return Err(ApiError::bad_request(
            "a form stays open between 1 hour and a year",
        ));
    }
    let id = new_id()?;
    sqlx::query(
        "INSERT INTO intake_forms (id, channel_id, created_by_device, sealed, expires_at)
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

pub async fn update(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path((channel, id)): Path<(ChannelId, String)>,
    Json(req): Json<UpdatePayLink>,
) -> ApiResult<StatusCode> {
    require_member(&s.db, channel, dev.device_id).await?;
    let sealed = decode_sealed(&req.sealed)?;
    let done = sqlx::query("UPDATE intake_forms SET sealed = $1 WHERE id = $2 AND channel_id = $3")
        .bind(sealed)
        .bind(&id)
        .bind(channel)
        .execute(&s.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found("no such form"));
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
        "UPDATE intake_forms SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND channel_id = $2",
    )
    .bind(&id)
    .bind(channel)
    .execute(&s.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found("no such form"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn submissions(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path((channel, id)): Path<(ChannelId, String)>,
) -> ApiResult<Json<Vec<FormSubmission>>> {
    require_member(&s.db, channel, dev.device_id).await?;
    let rows: Vec<(i64, Vec<u8>, f64)> = sqlx::query_as(
        "SELECT s.id, s.sealed, extract(epoch FROM s.created_at)::float8 * 1000
         FROM intake_submissions s JOIN intake_forms f ON f.id = s.form_id
         WHERE f.id = $1 AND f.channel_id = $2 ORDER BY s.id LIMIT 500",
    )
    .bind(&id)
    .bind(channel)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, sealed, at)| FormSubmission {
                id,
                sealed: STANDARD.encode(sealed),
                at_ms: at as u64,
            })
            .collect(),
    ))
}

pub async fn delete_submission(
    State(s): State<AppState>,
    dev: AuthDevice,
    Path((channel, id, sub)): Path<(ChannelId, String, i64)>,
) -> ApiResult<StatusCode> {
    require_member(&s.db, channel, dev.device_id).await?;
    sqlx::query(
        "DELETE FROM intake_submissions s USING intake_forms f
         WHERE s.id = $1 AND s.form_id = f.id AND f.id = $2 AND f.channel_id = $3",
    )
    .bind(sub)
    .bind(&id)
    .bind(channel)
    .execute(&s.db)
    .await?;
    // Deleting twice (two devices importing at once) is fine.
    Ok(StatusCode::NO_CONTENT)
}

// ---------- public, no account ----------

const ACTIVE: &str = "id = $1 AND revoked_at IS NULL AND expires_at > now()";

pub async fn public_sealed(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT sealed FROM intake_forms WHERE {ACTIVE}"
    )))
    .bind(&id)
    .fetch_optional(&s.db)
    .await?;
    let (sealed,) = row.ok_or_else(|| ApiError::not_found("this form is closed"))?;
    let body = PublicPayLink {
        sealed: STANDARD.encode(sealed),
        claimed_paid_at_ms: None,
    };
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

pub async fn public_submit(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SubmitForm>,
) -> ApiResult<StatusCode> {
    let sealed = STANDARD
        .decode(&req.sealed)
        .map_err(|_| ApiError::bad_request("sealed must be base64"))?;
    // Ephemeral key, nonce and tag at least.
    if sealed.len() < 65 + 12 + 16 || sealed.len() > MAX_ANSWER {
        return Err(ApiError::bad_request("answers are too short or too long"));
    }
    let mut tx = s.db.begin().await?;
    // Locks the form row so the pending count can't be raced past the cap.
    let open: Option<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM intake_forms WHERE {ACTIVE} FOR UPDATE"
    )))
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    if open.is_none() {
        return Err(ApiError::not_found("this form is closed"));
    }
    let (pending,): (i64,) = sqlx::query_as("SELECT count(*) FROM intake_submissions WHERE form_id = $1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if pending >= MAX_PENDING {
        return Err(ApiError::unavailable(
            "this form has too many answers waiting; try again later",
        ));
    }
    sqlx::query("INSERT INTO intake_submissions (form_id, sealed) VALUES ($1, $2)")
        .bind(&id)
        .bind(sealed)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn public_page(Path(_id): Path<String>) -> Response {
    page("text/html; charset=utf-8", include_str!("../static/form.html"))
}

pub async fn public_js() -> Response {
    page(
        "text/javascript; charset=utf-8",
        include_str!("../static/form.js"),
    )
}
