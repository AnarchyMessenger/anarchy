//! Test helpers shared by the workspace's integration tests.
//!
//! Tests need Postgres. Point `ANARCHY_TEST_DATABASE_URL` at a server where the
//! user may create databases (for example `postgres://postgres@127.0.0.1:5432/postgres`,
//! or `docker compose up db`). Each test gets its own fresh database.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anarchy_server::email::MailFuture;
use anarchy_server::{AppState, Config, EmailConfig, Mailer, OidcConfig, router};
use axum::Json;
use axum::extract::{Form, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use p256::SecretKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::EncodePrivateKey;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::{ConnectOptions, Executor};
use uuid::Uuid;

pub const AUDIENCE: &str = "anarchy-desktop";

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// A local OpenID Connect provider: discovery, JWKS, and an authorization code
/// endpoint with PKCE that signs the user in immediately as `login_hint`
/// (the test plays the browser). Issues ES256 ID tokens.
pub struct TestIdp {
    pub issuer: String,
    signer: Arc<Signer>,
}

struct Signer {
    issuer: String,
    kid: String,
    key: EncodingKey,
}

impl Signer {
    fn sign(&self, claims: &Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.kid.clone());
        jsonwebtoken::encode(&header, claims, &self.key).unwrap()
    }

    fn id_token(&self, sub: &str, name: &str) -> String {
        let now = now_secs();
        self.sign(&json!({
            "iss": self.issuer, "aud": AUDIENCE, "sub": sub, "name": name,
            "email": format!("{sub}@example.test"), "iat": now, "exp": now + 600,
        }))
    }
}

/// Codes handed out by /authorize, waiting to be traded at /token.
#[derive(Clone)]
struct PendingCode {
    sub: String,
    client_id: String,
    redirect_uri: String,
    challenge: String,
}

type Codes = Arc<Mutex<HashMap<String, PendingCode>>>;

fn random_p256_key() -> SecretKey {
    loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).unwrap();
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return key;
        }
    }
}

async fn authorize(State(codes): State<Codes>, Query(q): Query<HashMap<String, String>>) -> Response {
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    if get("response_type") != "code"
        || get("code_challenge_method") != "S256"
        || get("client_id") != AUDIENCE
    {
        return (StatusCode::BAD_REQUEST, "bad authorization request").into_response();
    }
    let code = Uuid::new_v4().simple().to_string();
    codes.lock().unwrap().insert(
        code.clone(),
        PendingCode {
            sub: q.get("login_hint").cloned().unwrap_or_else(|| "tester".into()),
            client_id: get("client_id"),
            redirect_uri: get("redirect_uri"),
            challenge: get("code_challenge"),
        },
    );
    let mut to = get("redirect_uri");
    to.push_str(&format!("?code={code}&state={}", get("state")));
    (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
}

async fn token(
    State((codes, signer)): State<(Codes, Arc<Signer>)>,
    Form(f): Form<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| f.get(k).cloned().unwrap_or_default();
    let Some(pending) = codes.lock().unwrap().remove(&get("code")) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))).into_response();
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(get("code_verifier").as_bytes()));
    if get("grant_type") != "authorization_code"
        || challenge != pending.challenge
        || get("redirect_uri") != pending.redirect_uri
        || get("client_id") != pending.client_id
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))).into_response();
    }
    let id_token = signer.id_token(&pending.sub, &pending.sub);
    Json(json!({"id_token": id_token, "token_type": "Bearer", "expires_in": 600})).into_response()
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
        let discovery = json!({
            "issuer": issuer,
            "jwks_uri": format!("{issuer}/jwks"),
            "authorization_endpoint": format!("{issuer}/authorize"),
            "token_endpoint": format!("{issuer}/token"),
        });
        let der = secret.to_pkcs8_der().unwrap();
        let signer = Arc::new(Signer {
            issuer: issuer.clone(),
            kid,
            key: EncodingKey::from_ec_der(der.as_bytes()),
        });
        let codes: Codes = Arc::default();

        let app = axum::Router::new()
            .route(
                "/.well-known/openid-configuration",
                axum::routing::get(move || async move { axum::Json(discovery) }),
            )
            .route(
                "/jwks",
                axum::routing::get(move || async move { axum::Json(jwks) }),
            )
            .route(
                "/authorize",
                axum::routing::get(authorize).with_state(codes.clone()),
            )
            .route(
                "/token",
                axum::routing::post(token).with_state((codes, signer.clone())),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { issuer, signer }
    }

    /// A valid ID token for `sub`, good for ten minutes.
    pub fn id_token(&self, sub: &str, name: &str) -> String {
        self.signer.id_token(sub, name)
    }

    /// Signs arbitrary claims with this provider's key, for negative tests.
    pub fn sign(&self, claims: Value) -> String {
        self.signer.sign(&claims)
    }
}

/// Creates an empty database for one test.
pub async fn fresh_database() -> PgPool {
    let url = std::env::var("ANARCHY_TEST_DATABASE_URL").expect(
        "set ANARCHY_TEST_DATABASE_URL to a Postgres the tests can create databases on, \
         e.g. postgres://postgres@127.0.0.1:5432/postgres (docker compose up db)",
    );
    let admin: PgConnectOptions = url.parse().expect("invalid ANARCHY_TEST_DATABASE_URL");
    let now = now_secs();
    let name = format!("anarchy_t_{now}_{}", Uuid::new_v4().simple());
    let mut conn = admin.connect().await.expect("cannot reach test Postgres");
    // Tests never drop their databases (pools are still open when they end), so clear
    // out ones older than ten minutes: no test runs that long.
    let old: Vec<String> =
        sqlx::query_scalar("SELECT datname FROM pg_database WHERE datname LIKE 'anarchy_t_%'")
            .fetch_all(&mut conn)
            .await
            .unwrap_or_default();
    for db in old {
        let created = db
            .split('_')
            .nth(2)
            .and_then(|t| t.parse::<u64>().ok())
            .unwrap_or(0);
        if created + 600 < now {
            // Names come from pg_database and match our own pattern, never from input.
            let _ = conn
                .execute(sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                    "DROP DATABASE IF EXISTS \"{db}\" WITH (FORCE)"
                ))))
                .await;
        }
    }
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
    /// Emails the server "sent". Email sign-in accepts `@northwind.org` addresses.
    pub mailbox: Arc<Mailbox>,
}

/// Which sign-in methods a test server offers. All on by default.
pub struct TestOptions {
    pub sso: bool,
    pub email: bool,
    pub guests: bool,
}

impl Default for TestOptions {
    fn default() -> Self {
        Self {
            sso: true,
            email: true,
            guests: true,
        }
    }
}

/// Captures sign-in emails instead of sending them.
#[derive(Default)]
pub struct Mailbox {
    sent: Mutex<Vec<(String, String)>>,
}

impl Mailbox {
    /// The newest 6-digit code sent to `to`.
    pub fn last_code(&self, to: &str) -> Option<String> {
        let sent = self.sent.lock().unwrap();
        let (_, body) = sent.iter().rev().find(|(addr, _)| addr == to)?;
        body.split_whitespace()
            .find(|w| w.len() == 6 && w.chars().all(|c| c.is_ascii_digit()))
            .map(str::to_owned)
    }

    pub fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

impl Mailer for Mailbox {
    fn send<'a>(&'a self, to: &'a str, _subject: &'a str, body: &'a str) -> MailFuture<'a> {
        self.sent.lock().unwrap().push((to.to_owned(), body.to_owned()));
        Box::pin(async { Ok(()) })
    }
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with_guests(true).await
    }

    pub async fn start_with_guests(guests_enabled: bool) -> Self {
        Self::start_with(TestOptions {
            guests: guests_enabled,
            ..TestOptions::default()
        })
        .await
    }

    pub async fn start_with(options: TestOptions) -> Self {
        let guests_enabled = options.guests;
        let idp = TestIdp::start().await;
        let db = fresh_database().await;
        let mailbox = Arc::new(Mailbox::default());
        let state = AppState::new(
            db.clone(),
            Config {
                oidc: options.sso.then(|| OidcConfig {
                    issuer: idp.issuer.clone(),
                    audience: AUDIENCE.into(),
                    jwks_url: None,
                }),
                org_name: "Northwind".into(),
                guests_enabled,
                email: options.email.then(|| EmailConfig {
                    allowed_domains: vec!["northwind.org".into()],
                    mailer: mailbox.clone(),
                }),
                session_ttl: Duration::from_secs(3600),
            },
        )
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = router(state);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            idp,
            db,
            mailbox,
        }
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
