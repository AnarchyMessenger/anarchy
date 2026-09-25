use std::net::SocketAddr;

use anarchy_server::{SharedStore, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let addr: SocketAddr = std::env::var("ANARCHY_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()
        .expect("ANARCHY_LISTEN must be host:port");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("anarchy-server listening on {addr}");
    axum::serve(listener, router(SharedStore::default())).await
}
