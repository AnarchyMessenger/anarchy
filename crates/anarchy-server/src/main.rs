use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anarchy_server::{AppState, Config, EmailConfig, LogMailer, Mailer, OidcConfig, SmtpMailer, router};
use tracing_subscriber::EnvFilter;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set (see docs/SELF-HOSTING.md)"))
}

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "true" || v == "1")
}

/// Identity provider sign-in, if `ANARCHY_OIDC_ISSUER` is set.
fn oidc_config() -> Option<OidcConfig> {
    let issuer = std::env::var("ANARCHY_OIDC_ISSUER").ok()?;
    Some(OidcConfig {
        issuer,
        audience: env("ANARCHY_OIDC_AUDIENCE"),
        jwks_url: std::env::var("ANARCHY_OIDC_JWKS_URL").ok(),
    })
}

/// Email one-time codes, if `ANARCHY_EMAIL_DOMAINS` is set.
fn email_config() -> Option<EmailConfig> {
    let domains: Vec<String> = std::env::var("ANARCHY_EMAIL_DOMAINS")
        .ok()?
        .split(',')
        .map(|d| d.trim().trim_start_matches('@').to_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    let mailer: Arc<dyn Mailer> = if flag("ANARCHY_EMAIL_DEV_LOG") {
        tracing::warn!(
            "ANARCHY_EMAIL_DEV_LOG is on: sign-in codes are printed to this log, not emailed. Development only."
        );
        Arc::new(LogMailer)
    } else {
        let mailer = SmtpMailer::new(&env("ANARCHY_SMTP_URL"), &env("ANARCHY_EMAIL_FROM"))
            .unwrap_or_else(|e| panic!("email sign-in: {e}"));
        Arc::new(mailer)
    };
    Some(EmailConfig {
        allowed_domains: domains,
        mailer,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let addr: SocketAddr = std::env::var("ANARCHY_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()?;
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect(&env("DATABASE_URL"))
        .await?;
    let config = Config {
        oidc: oidc_config(),
        email: email_config(),
        org_name: env("ANARCHY_ORG_NAME"),
        guests_enabled: flag("ANARCHY_GUESTS_ENABLED"),
        open_signup: flag("ANARCHY_OPEN_SIGNUP"),
        oidc_client_secret: std::env::var("ANARCHY_OIDC_CLIENT_SECRET").ok(),
        session_ttl: Duration::from_secs(
            std::env::var("ANARCHY_SESSION_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30 * 24 * 3600),
        ),
    };
    if config.oidc.is_none() && config.email.is_none() {
        panic!(
            "no way to sign in: set ANARCHY_OIDC_ISSUER or ANARCHY_EMAIL_DOMAINS (see docs/SELF-HOSTING.md)"
        );
    }
    let state = AppState::new(db, config).await?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("anarchy-server listening on {addr}");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
