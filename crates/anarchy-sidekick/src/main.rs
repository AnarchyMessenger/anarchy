//! `anarchy-sidekick`: runs people's server-side sidekicks next to an Anarchy server.
//! See docs/SELF-HOSTING.md.

use std::time::Duration;

use anarchy_sidekick::Host;
use tracing_subscriber::EnvFilter;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set (see docs/SELF-HOSTING.md)"))
}

fn key() -> [u8; 32] {
    let hex = env("ANARCHY_SIDEKICK_KEY");
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .filter_map(|i| hex.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok()))
        .collect();
    bytes
        .try_into()
        .unwrap_or_else(|_| panic!("ANARCHY_SIDEKICK_KEY must be 64 hex characters (openssl rand -hex 32)"))
}

// One thread: devices aren't `Sync`, and one host is plenty for an organisation.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let mut host = Host::new(
        env("ANARCHY_SERVER_URL"),
        env("ANARCHY_SIDEKICK_HOST_TOKEN"),
        env("ANARCHY_SIDEKICK_DIR"),
        key(),
    );
    tracing::info!("anarchy-sidekick running");
    loop {
        match host.tick().await {
            Ok(r) if r != Default::default() => tracing::info!(?r, "tick"),
            Ok(_) => {}
            Err(e) => tracing::warn!("tick failed: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
