//! Test helpers shared by the workspace's integration tests.
//!
//! Tests need Postgres. Point `ANARCHY_TEST_DATABASE_URL` at a server where the
//! user may create databases (for example `postgres://postgres@127.0.0.1:5432/postgres`,
//! or `docker compose up db`). Each test gets its own fresh database.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anarchy_server::{AppState, Config, OidcConfig, router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use p256::SecretKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::EncodePrivateKey;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::{ConnectOptions, Executor};
use uuid::Uuid;

pub const AUDIENCE: &str = "anarchy-desktop";

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// A local OpenID Connect provider: serves discovery and JWKS, signs ES256 ID tokens.
pub struct TestIdp {
    pub issuer: String,
    kid: String,
    key: EncodingKey,
}

fn random_p256_key() -> SecretKey {
    loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).unwrap();
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return key;
        }
    }
}

impl TestIdp {
    pub async fn start() -> Self {
        let secret = random_p256_key();
        let point = secret.public_key().to_encoded_point(false);
        let kid = Uuid::new_v4().to_string();
        let jwks = json!({ "keys": [{
            "kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": kid,
            "x": URL_SAFE_NO_PAD.encode(point.x().unwrap()),
            "y": URL_SAFE_NO_PAD.encode(point.y().unwrap()),
        }]});

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let discovery = json!({ "issuer": issuer, "jwks_uri": format!("{issuer}/jwks") });
        let app = axum::Router::new()
            .route(
                "/.well-known/openid-configuration",
                axum::routing::get(move || async move { axum::Json(discovery) }),
            )
            .route(
                "/jwks",
                axum::routing::get(move || async move { axum::Json(jwks) }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let der = secret.to_pkcs8_der().unwrap();
        Self {
            issuer,
            kid,
            key: EncodingKey::from_ec_der(der.as_bytes()),
        }
    }

    /// A valid ID token for `sub`, good for ten minutes.
    pub fn id_token(&self, sub: &str, name: &str) -> String {
        let now = now_secs();
        self.sign(json!({
            "iss": self.issuer, "aud": AUDIENCE, "sub": sub, "name": name,
            "email": format!("{sub}@example.test"), "iat": now, "exp": now + 600,
        }))
    }

    /// Signs arbitrary claims with this provider's key, for negative tests.
    pub fn sign(&self, claims: Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.kid.clone());
        jsonwebtoken::encode(&header, &claims, &self.key).unwrap()
    }
}

/// Creates an empty database for one test.
pub async fn fresh_database() -> PgPool {
    let url = std::env::var("ANARCHY_TEST_DATABASE_URL").expect(
        "set ANARCHY_TEST_DATABASE_URL to a Postgres the tests can create databases on, \
         e.g. postgres://postgres@127.0.0.1:5432/postgres (docker compose up db)",
    );
    let admin: PgConnectOptions = url.parse().expect("invalid ANARCHY_TEST_DATABASE_URL");
    let name = format!("anarchy_t_{}", Uuid::new_v4().simple());
    let mut conn = admin.connect().await.expect("cannot reach test Postgres");
    // `name` is generated above from a UUID, never from input.
    conn.execute(sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE DATABASE \"{name}\""
    ))))
    .await
    .unwrap();
    PgPoolOptions::new()
        .max_connections(10)
        .connect_with(admin.database(&name))
        .await
        .unwrap()
}

/// A running server with its own database and identity provider.
pub struct TestServer {
    pub url: String,
    pub idp: TestIdp,
    pub db: PgPool,
}

impl TestServer {
    pub async fn start() -> Self {
        let idp = TestIdp::start().await;
        let db = fresh_database().await;
        let state = AppState::new(
            db.clone(),
            Config {
                oidc: OidcConfig {
                    issuer: idp.issuer.clone(),
                    audience: AUDIENCE.into(),
                    jwks_url: None,
                },
                org_name: "Northwind".into(),
                session_ttl: Duration::from_secs(3600),
            },
        )
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = router(state);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, idp, db }
    }

    /// Every payload stored for a channel, for asserting the server holds no plaintext.
    pub async fn payloads(&self, channel: Uuid) -> Vec<Vec<u8>> {
        sqlx::query_scalar("SELECT payload FROM channel_events WHERE channel_id = $1 ORDER BY seq")
            .bind(channel)
            .fetch_all(&self.db)
            .await
            .unwrap()
    }
}
