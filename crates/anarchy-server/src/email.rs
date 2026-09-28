//! Sign-in with a one-time code sent to a work email address, for organisations
//! that don't run an identity provider.
//!
//! Only addresses on the configured domains can sign in; otherwise anyone on the
//! internet could create an account in the organisation. Codes are 6 digits,
//! last 10 minutes, allow 5 tries each, and an address is locked for a day after
//! 20 failed tries across codes, which caps guessing at a tiny chance per day.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anarchy_proto::{EmailStart, EmailVerify, Session};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{ApiError, ApiResult, AppState};

const CODE_TTL: Duration = Duration::from_secs(10 * 60);
const RESEND_AFTER: Duration = Duration::from_secs(30);
const TRIES_PER_CODE: i32 = 5;
const FAILED_TRIES_PER_DAY: i64 = 20;

pub type MailFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// Delivers sign-in codes. SMTP in production; tests capture them.
pub trait Mailer: Send + Sync {
    fn send<'a>(&'a self, to: &'a str, subject: &'a str, body: &'a str) -> MailFuture<'a>;
}

pub struct EmailConfig {
    /// Lowercase domains whose addresses may sign in, e.g. `["northwind.org"]`.
    pub allowed_domains: Vec<String>,
    pub mailer: Arc<dyn Mailer>,
}

/// Sends through an SMTP relay (`smtps://user:pass@smtp.example.org`).
pub struct SmtpMailer {
    transport: lettre::AsyncSmtpTransport<lettre::Tokio1Executor>,
    from: lettre::message::Mailbox,
}

impl SmtpMailer {
    pub fn new(url: &str, from: &str) -> Result<Self, String> {
        let transport = lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::from_url(url)
            .map_err(|e| format!("bad SMTP URL: {e}"))?
            .build();
        let from = from.parse().map_err(|e| format!("bad sender address: {e}"))?;
        Ok(Self { transport, from })
    }
}

impl Mailer for SmtpMailer {
    fn send<'a>(&'a self, to: &'a str, subject: &'a str, body: &'a str) -> MailFuture<'a> {
        Box::pin(async move {
            use lettre::AsyncTransport;
            let message = lettre::Message::builder()
                .from(self.from.clone())
                .to(to.parse().map_err(|e| format!("bad address: {e}"))?)
                .subject(subject)
                .body(body.to_owned())
                .map_err(|e| e.to_string())?;
            self.transport
                .send(message)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }
}

/// Development only: prints codes to the server log instead of sending them.
pub struct LogMailer;

impl Mailer for LogMailer {
    fn send<'a>(&'a self, to: &'a str, subject: &'a str, body: &'a str) -> MailFuture<'a> {
        Box::pin(async move {
            tracing::warn!("DEV MAILER (not sent) to={to} subject={subject:?}\n{body}");
            Ok(())
        })
    }
}

fn normalize_email(raw: &str) -> Option<(String, String)> {
    let email = raw.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || email.contains(' ')
    {
        return None;
    }
    Some((email.clone(), domain.to_owned()))
}

fn code_hash(email: &str, code: &str) -> Vec<u8> {
    Sha256::digest(format!("{email}\n{code}").as_bytes()).to_vec()
}

fn new_code() -> String {
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).expect("OS random number generator unavailable");
        let n = u32::from_le_bytes(b);
        // Rejection sampling keeps every code equally likely.
        if n < 4_294_000_000 {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

fn config(s: &AppState) -> ApiResult<&EmailConfig> {
    s.email
        .as_deref()
        .ok_or_else(|| ApiError::forbidden("this workspace doesn't use email sign-in"))
}

pub async fn start(State(s): State<AppState>, Json(req): Json<EmailStart>) -> ApiResult<StatusCode> {
    let cfg = config(&s)?;
    let (email, domain) =
        normalize_email(&req.email).ok_or_else(|| ApiError::bad_request("enter a valid email address"))?;
    if !cfg.allowed_domains.iter().any(|d| d == &domain) {
        return Err(ApiError::forbidden(format!(
            "{} only accepts work addresses at {}",
            s.org_name,
            cfg.allowed_domains.join(", ")
        )));
    }
    let recent: Option<(i32,)> = sqlx::query_as(
        // Only an unused code blocks a resend: signing in on a second device right after is fine.
        "SELECT 1 FROM email_codes
         WHERE email = $1 AND used_at IS NULL AND created_at > now() - make_interval(secs => $2)",
    )
    .bind(&email)
    .bind(RESEND_AFTER.as_secs() as f64)
    .fetch_optional(&s.db)
    .await?;
    if recent.is_some() {
        return Err(ApiError::too_many(
            "a code was just sent; wait 30 seconds before asking again",
        ));
    }
    let code = new_code();
    sqlx::query("INSERT INTO email_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))")
        .bind(&email)
        .bind(code_hash(&email, &code))
        .bind(CODE_TTL.as_secs() as f64)
        .execute(&s.db)
        .await?;
    let body = format!(
        "Your sign-in code for {org} is {code}\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.",
        org = s.org_name
    );
    cfg.mailer
        .send(
            &email,
            &format!("{code} is your {} sign-in code", s.org_name),
            &body,
        )
        .await
        .map_err(|e| {
            tracing::error!("couldn't send sign-in code to {email}: {e}");
            ApiError::unavailable("couldn't send the email; try again in a minute")
        })?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn verify(State(s): State<AppState>, Json(req): Json<EmailVerify>) -> ApiResult<Json<Session>> {
    let cfg = config(&s)?;
    let (email, domain) =
        normalize_email(&req.email).ok_or_else(|| ApiError::bad_request("enter a valid email address"))?;
    if !cfg.allowed_domains.iter().any(|d| d == &domain) {
        return Err(ApiError::forbidden("this address can't sign in here"));
    }
    let failed_today: i64 = sqlx::query_scalar(
        "SELECT coalesce(sum(attempts), 0) FROM email_codes WHERE email = $1 AND created_at > now() - interval '1 day'",
    )
    .bind(&email)
    .fetch_one(&s.db)
    .await?;
    if failed_today >= FAILED_TRIES_PER_DAY {
        return Err(ApiError::too_many(
            "too many wrong codes for this address today; try again tomorrow",
        ));
    }

    let mut tx = s.db.begin().await?;
    let latest: Option<(i64, Vec<u8>, i32)> = sqlx::query_as(
        "SELECT id, code_hash, attempts FROM email_codes
         WHERE email = $1 AND used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await?;
    let (id, hash, attempts) =
        latest.ok_or_else(|| ApiError::unauthorized_msg("this code has expired; ask for a new one"))?;
    if attempts >= TRIES_PER_CODE {
        return Err(ApiError::unauthorized_msg(
            "too many tries with this code; ask for a new one",
        ));
    }
    let typed: String = req.code.chars().filter(|c| c.is_ascii_digit()).collect();
    let ok = constant_time_eq(&code_hash(&email, &typed), &hash);
    if !ok {
        sqlx::query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(ApiError::unauthorized_msg("that code isn't right"));
    }
    sqlx::query("UPDATE email_codes SET used_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    let name = email.split('@').next().unwrap_or(&email).to_owned();
    let (user_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO users (id, org_id, oidc_issuer, oidc_subject, display_name, email)
         VALUES ($1, $2, 'anarchy:email', $3, $4, $3)
         ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(s.org_id)
    .bind(&email)
    .bind(&name)
    .fetch_one(&mut *tx)
    .await?;
    let session = crate::create_session(&mut tx, &s, user_id, None, false).await?;
    tx.commit().await?;
    Ok(Json(session))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_normalised_and_checked() {
        assert_eq!(
            normalize_email("  Maya@Northwind.ORG "),
            Some(("maya@northwind.org".into(), "northwind.org".into()))
        );
        assert_eq!(normalize_email("no-at-sign"), None);
        assert_eq!(normalize_email("a@b@northwind.org"), None);
        assert_eq!(normalize_email("maya@localhost"), None);
        assert_eq!(normalize_email("@northwind.org"), None);
    }

    #[test]
    fn codes_are_six_digits() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|d| d.is_ascii_digit()));
        }
    }
}
