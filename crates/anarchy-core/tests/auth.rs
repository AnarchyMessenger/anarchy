//! Sign-in and access control: the server must refuse forged or expired
//! identity tokens, unauthenticated calls, non-members and spoofed devices.

use anarchy_core::{Client, Device, Error};
use anarchy_proto::{DEVICE_HEADER, InboxItem, OidcLogin};
use anarchy_testkit::{AUDIENCE, TestIdp, TestServer, now_secs};
use serde_json::json;

async fn user(server: &TestServer, name: &str) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, Device::new().unwrap())
        .await
        .unwrap()
}

async fn login_status(server: &TestServer, id_token: String) -> u16 {
    reqwest::Client::new()
        .post(format!("{}/v1/auth/oidc", server.url))
        .json(&OidcLogin { id_token })
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn sign_in_accepts_only_valid_tokens_from_the_configured_provider() {
    let server = TestServer::start().await;
    let idp = &server.idp;
    let now = now_secs();

    assert_eq!(login_status(&server, idp.id_token("alice", "Alice")).await, 200);

    let wrong_audience =
        idp.sign(json!({"iss": idp.issuer, "aud": "someone-else", "sub": "a", "exp": now + 600}));
    assert_eq!(login_status(&server, wrong_audience).await, 401);

    let wrong_issuer =
        idp.sign(json!({"iss": "https://evil.test", "aud": AUDIENCE, "sub": "a", "exp": now + 600}));
    assert_eq!(login_status(&server, wrong_issuer).await, 401);

    let expired = idp.sign(json!({"iss": idp.issuer, "aud": AUDIENCE, "sub": "a", "exp": now - 3600}));
    assert_eq!(login_status(&server, expired).await, 401);

    // Right issuer name, but signed by a key the provider never published.
    let impostor = TestIdp::start().await;
    let forged = impostor.sign(json!({"iss": idp.issuer, "aud": AUDIENCE, "sub": "a", "exp": now + 600}));
    assert_eq!(login_status(&server, forged).await, 401);

    // Unsigned token (alg "none").
    let unsigned = format!(
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.{}.",
        base64_url(&json!({"iss": idp.issuer, "aud": AUDIENCE, "sub": "a", "exp": now + 600}).to_string())
    );
    assert_eq!(login_status(&server, unsigned).await, 401);
}

fn base64_url(s: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s)
}

#[tokio::test]
async fn session_tokens_are_stored_hashed() {
    let server = TestServer::start().await;
    let alice = user(&server, "Alice").await;
    let stored: Vec<Vec<u8>> = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_all(&server.db)
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_ne!(stored[0], alice.session_token().as_bytes());
    assert_eq!(stored[0].len(), 32, "SHA-256 digest");
}

#[tokio::test]
async fn only_members_can_read_or_write_a_channel() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let mut mallory = user(&server, "Mallory").await;
    let channel = alice.create_channel().await.unwrap();
    alice.send(channel, b"board only").await.unwrap();

    // Not a member: the channel looks like it doesn't exist.
    match mallory.sync(channel).await {
        Err(Error::Api { status: 404, .. }) => {}
        other => panic!("expected 404, got {other:?}"),
    }
    let status = reqwest::Client::new()
        .post(format!("{}/v1/channels/{channel}/events", server.url))
        .bearer_auth(mallory.session_token())
        .header(DEVICE_HEADER, mallory.device().id().to_string())
        .json(&anarchy_proto::AppendRequest {
            epoch: 0,
            kind: anarchy_proto::EventKind::Application,
            idempotency_key: uuid::Uuid::new_v4(),
            payload: anarchy_proto::Blob(b"spoofed".to_vec()),
            adds: vec![],
        })
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404);
    match mallory.members(channel).await {
        Err(Error::Api { status: 404, .. }) => {}
        other => panic!("expected 404, got {other:?}"),
    }

    // No session at all.
    let status = reqwest::get(format!("{}/v1/channels/{channel}/events", server.url))
        .await
        .unwrap()
        .status();
    assert_eq!(status, 401);
}

#[tokio::test]
async fn a_user_cannot_act_as_someone_elses_device() {
    let server = TestServer::start().await;
    let alice = user(&server, "Alice").await;
    let mallory = user(&server, "Mallory").await;
    let http = reqwest::Client::new();

    // Mallory's session with Alice's device ID.
    let status = http
        .get(format!("{}/v1/devices/{}/inbox", server.url, alice.device().id()))
        .bearer_auth(mallory.session_token())
        .header(DEVICE_HEADER, alice.device().id().to_string())
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 403);

    // Mallory's own device reading Alice's inbox.
    let status = http
        .get(format!("{}/v1/devices/{}/inbox", server.url, alice.device().id()))
        .bearer_auth(mallory.session_token())
        .header(DEVICE_HEADER, mallory.device().id().to_string())
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 403);
}

#[tokio::test]
async fn welcomes_can_only_be_sent_by_members_to_added_devices() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let bob = user(&server, "Bob").await;
    let mallory = user(&server, "Mallory").await;
    let channel = alice.create_channel().await.unwrap();

    // Mallory isn't a member, so she can't drop a Welcome for this channel into Bob's inbox.
    let status = reqwest::Client::new()
        .post(format!("{}/v1/devices/{}/inbox", server.url, bob.device().id()))
        .bearer_auth(mallory.session_token())
        .header(DEVICE_HEADER, mallory.device().id().to_string())
        .json(&InboxItem {
            channel,
            welcome: anarchy_proto::Blob(vec![1, 2, 3]),
        })
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404);
}
