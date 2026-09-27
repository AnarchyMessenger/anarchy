use std::net::SocketAddr;
use std::time::Duration;

use anarchy_server::{AppState, Config, OidcConfig, router};
use tracing_subscriber::EnvFilter;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set (see docs/SELF-HOSTING.md)"))
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
        oidc: OidcConfig {
            issuer: env("ANARCHY_OIDC_ISSUER"),
            audience: env("ANARCHY_OIDC_AUDIENCE"),
            jwks_url: std::env::var("ANARCHY_OIDC_JWKS_URL").ok(),
        },
        org_name: env("ANARCHY_ORG_NAME"),
        session_ttl: Duration::from_secs(
            std::env::var("ANARCHY_SESSION_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30 * 24 * 3600),
        ),
    };
    let state = AppState::new(db, config).await?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("anarchy-server listening on {addr}");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
