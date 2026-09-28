//! Guests: people without an account who join with an invite code.

use std::time::Duration;

use anarchy_core::{Client, Device, Error};
use anarchy_testkit::TestServer;

async fn member(server: &TestServer, name: &str) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, Device::new().unwrap())
        .await
        .unwrap()
}

async fn guest(server: &TestServer, code: &str, name: &str) -> Result<Client, Error> {
    Client::join_as_guest(&server.url, code, name, Device::new().unwrap()).await
}

fn status(result: Result<Client, Error>) -> u16 {
    match result {
        Err(Error::Api { status, .. }) => status,
        Ok(_) => 200,
        Err(e) => panic!("unexpected error: {e}"),
    }
}

#[tokio::test]
async fn a_guest_joins_with_an_invite_and_can_be_added_to_a_channel() {
    let server = TestServer::start().await;
    let mut alice = member(&server, "Alice").await;
    let invite = alice.create_invite(Duration::from_secs(3600), 5).await.unwrap();
    assert!(
        invite.code.contains('-'),
        "grouped for reading aloud: {}",
        invite.code
    );

    // Case, spaces and dashes don't matter when typing the code.
    let typed = invite.code.to_uppercase().replace('-', " ");
    let mut auditor = guest(&server, &typed, "Auditor (Kowalski & Co)").await.unwrap();
    assert!(auditor.session().is_guest);
    assert!(
        auditor.session().expires_at_ms <= invite.expires_at_ms,
        "access ends with the invite"
    );

    auditor.publish_key_packages(1).await.unwrap();
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, auditor.device().id()).await.unwrap();
    alice
        .send(channel, b"Q3 figures are in the folder")
        .await
        .unwrap();
    assert_eq!(auditor.accept_invites().await.unwrap(), vec![channel]);
    assert_eq!(
        auditor.sync(channel).await.unwrap()[0].body,
        b"Q3 figures are in the folder"
    );
}

#[tokio::test]
async fn invite_codes_are_single_purpose() {
    let server = TestServer::start().await;
    let alice = member(&server, "Alice").await;

    let once = alice.create_invite(Duration::from_secs(3600), 1).await.unwrap();
    assert_eq!(status(guest(&server, &once.code, "First").await), 200);
    assert_eq!(status(guest(&server, &once.code, "Second").await), 403, "used up");

    let revoked = alice.create_invite(Duration::from_secs(3600), 10).await.unwrap();
    alice.revoke_invite(revoked.id).await.unwrap();
    assert_eq!(
        status(guest(&server, &revoked.code, "Late").await),
        403,
        "revoked"
    );

    assert_eq!(
        status(guest(&server, "aaaa-bbbb-cccc-dddd-eeee-ffff-gg", "Guesser").await),
        403
    );

    let ok = alice.create_invite(Duration::from_secs(3600), 10).await.unwrap();
    assert_eq!(
        status(guest(&server, &ok.code, "   ").await),
        400,
        "a name is required"
    );
    assert_eq!(
        status(guest(&server, &ok.code, &"x".repeat(65)).await),
        400,
        "names are short"
    );
}

#[tokio::test]
async fn guests_cannot_invite_more_guests() {
    let server = TestServer::start().await;
    let alice = member(&server, "Alice").await;
    let invite = alice.create_invite(Duration::from_secs(3600), 1).await.unwrap();
    let visitor = guest(&server, &invite.code, "Visitor").await.unwrap();
    match visitor.create_invite(Duration::from_secs(3600), 1).await {
        Err(Error::Api { status: 403, .. }) => {}
        other => panic!("expected 403, got {other:?}"),
    }
}

#[tokio::test]
async fn a_workspace_can_turn_guests_off() {
    let server = TestServer::start_with_guests(false).await;
    let alice = member(&server, "Alice").await;
    assert!(
        !anarchy_core::oidc::workspace_config(&server.url)
            .await
            .unwrap()
            .guests_enabled
    );
    assert!(matches!(
        alice.create_invite(Duration::from_secs(3600), 1).await,
        Err(Error::Api { status: 403, .. })
    ));
    assert_eq!(status(guest(&server, "anything", "Visitor").await), 403);
}

#[tokio::test]
async fn an_expired_guest_is_locked_out_and_removed_from_channels() {
    let server = TestServer::start().await;
    let mut alice = member(&server, "Alice").await;
    let invite = alice.create_invite(Duration::from_secs(3600), 1).await.unwrap();
    let visitor = guest(&server, &invite.code, "Visitor").await.unwrap();
    visitor.publish_key_packages(1).await.unwrap();
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, visitor.device().id()).await.unwrap();

    // Fast-forward past the invite's end.
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 second' WHERE id = $1")
        .bind(visitor.user_id())
        .execute(&server.db)
        .await
        .unwrap();

    assert!(matches!(
        visitor.members(channel).await,
        Err(Error::Api { status: 401, .. })
    ));
    assert!(
        alice
            .members(channel)
            .await
            .unwrap()
            .iter()
            .all(|m| m.user_id != visitor.user_id())
    );
    assert_eq!(
        alice.remove_revoked(channel).await.unwrap(),
        vec![visitor.device().id()]
    );
    assert_eq!(alice.device().member_count(channel).unwrap(), 1);
}
