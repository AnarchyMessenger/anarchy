//! The desktop sign-in flow: authorization code + PKCE with a loopback redirect.
//! The test plays the browser.

use std::time::Duration;

use anarchy_core::{Client, Device, Error, oidc};
use anarchy_testkit::TestServer;

/// What the system browser does: follow the provider's redirect back to the app.
async fn act_as_browser(url: &str) -> String {
    let browser = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let resp = browser.get(url).send().await.unwrap();
    assert_eq!(resp.status(), 302, "provider should redirect back to the app");
    let back = resp.headers()["location"].to_str().unwrap().to_owned();
    assert!(
        back.starts_with("http://127.0.0.1:"),
        "loopback redirect, got {back}"
    );
    browser.get(&back).send().await.unwrap().text().await.unwrap()
}

#[tokio::test]
async fn signs_in_through_the_browser() {
    let server = TestServer::start().await;
    let config = oidc::workspace_config(&server.url).await.unwrap();
    assert_eq!(config.org_name, "Northwind");
    assert!(config.guests_enabled);

    let pending = oidc::begin(&config).await.unwrap();
    assert!(pending.url.contains("code_challenge_method=S256"));
    assert!(
        !pending.url.contains("code_verifier"),
        "the verifier never leaves the app"
    );
    let url = format!("{}&login_hint=alice", pending.url);
    let waiting = tokio::spawn(pending.finish(Duration::from_secs(10)));

    let page = act_as_browser(&url).await;
    assert!(page.contains("You're signed in"));
    let id_token = waiting.await.unwrap().unwrap();

    let alice = Client::sign_in(&server.url, &id_token, Device::new().unwrap())
        .await
        .unwrap();
    assert!(!alice.session().is_guest);
    // Same person signing in again maps to the same user.
    let again = Client::sign_in(
        &server.url,
        &server.idp.id_token("alice", "Alice"),
        Device::new().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(again.user_id(), alice.user_id());
}

#[tokio::test]
async fn a_redirect_with_the_wrong_state_is_refused() {
    let server = TestServer::start().await;
    let config = oidc::workspace_config(&server.url).await.unwrap();
    let pending = oidc::begin(&config).await.unwrap();
    let redirect = reqwest::Url::parse(&pending.url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.into_owned())
        .unwrap();
    let waiting = tokio::spawn(pending.finish(Duration::from_secs(10)));

    // A forged redirect: a code, but not our state.
    let page = reqwest::get(format!("{redirect}?code=stolen&state=forged"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        page.contains("You're signed in"),
        "the page can't know yet; the app checks state next"
    );
    match waiting.await.unwrap() {
        Err(Error::SignIn(msg)) => assert!(msg.contains("didn't match")),
        other => panic!("expected a state mismatch, got {other:?}"),
    }
}

#[tokio::test]
async fn an_identity_provider_error_is_reported() {
    let server = TestServer::start().await;
    let config = oidc::workspace_config(&server.url).await.unwrap();
    let pending = oidc::begin(&config).await.unwrap();
    let redirect = reqwest::Url::parse(&pending.url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.into_owned())
        .unwrap();
    let waiting = tokio::spawn(pending.finish(Duration::from_secs(10)));
    let page = reqwest::get(format!("{redirect}?error=access_denied"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("didn't complete"));
    assert!(matches!(waiting.await.unwrap(), Err(Error::SignIn(m)) if m.contains("access_denied")));
}

#[tokio::test]
async fn a_server_that_isnt_anarchy_is_reported_plainly() {
    let server = TestServer::start().await;
    // The identity provider is a real HTTP server, just not an Anarchy one.
    match oidc::workspace_config(&server.idp.issuer).await {
        Err(Error::SignIn(msg)) => assert!(msg.contains("doesn't look like an Anarchy server")),
        other => panic!("expected a clear error, got {other:?}"),
    }
}
