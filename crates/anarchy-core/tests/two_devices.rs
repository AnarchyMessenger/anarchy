//! Two devices exchange end-to-end encrypted messages in one channel through a
//! real server (Postgres, OIDC sign-in) and stay in sync across offline periods.

use anarchy_core::{Client, Delivered, Device, Error};
use anarchy_proto::{AppendRequest, AppendResponse, Blob, DEVICE_HEADER, EventKind};
use anarchy_testkit::TestServer;

fn bodies(msgs: &[Delivered]) -> Vec<&[u8]> {
    msgs.iter().map(|m| m.body.as_slice()).collect()
}

async fn user(server: &TestServer, name: &str) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, Device::new().unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn two_devices_exchange_encrypted_messages_and_catch_up() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let mut bob = user(&server, "Bob").await;
    bob.publish_key_packages(2).await.unwrap();

    // Alice creates a channel and adds Bob.
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    assert_eq!(alice.device().member_count(channel).unwrap(), 2);
    let members = alice.members(channel).await.unwrap();
    assert_eq!(members.len(), 2);
    assert!(members.iter().any(|m| m.user_id == bob.user_id()));

    // Alice writes before Bob has even accepted the invite.
    alice.send(channel, b"hello bob").await.unwrap();

    // Bob joins and catches up: he skips the commit that added him and reads the message.
    assert_eq!(bob.accept_invites().await.unwrap(), vec![channel]);
    assert_eq!(
        bob.device().epoch(channel).unwrap(),
        alice.device().epoch(channel).unwrap()
    );
    let got = bob.sync(channel).await.unwrap();
    assert_eq!(bodies(&got), vec![b"hello bob".as_slice()]);
    assert_eq!(got[0].sender, alice.device().id());

    // Bob goes offline; Alice keeps writing. On reconnect he gets exactly those, in order.
    for text in ["one", "two", "three"] {
        alice.send(channel, text.as_bytes()).await.unwrap();
    }
    let got = bob.sync(channel).await.unwrap();
    assert_eq!(bodies(&got), vec![b"one".as_slice(), b"two", b"three"]);
    assert!(got.windows(2).all(|w| w[0].seq < w[1].seq));

    // Syncing again with nothing new is a no-op.
    assert!(bob.sync(channel).await.unwrap().is_empty());

    // Bob replies; Alice receives it and never sees her own messages echoed back.
    bob.send(channel, b"hi alice").await.unwrap();
    let got = alice.sync(channel).await.unwrap();
    assert_eq!(bodies(&got), vec![b"hi alice".as_slice()]);
    assert_eq!(alice.cursor(channel), bob.cursor(channel) + 1);

    // The server holds ciphertext only.
    let payloads = server.payloads(channel).await;
    assert_eq!(payloads.len(), 6, "1 commit + 5 application messages");
    for plaintext in [b"hello bob".as_slice(), b"one", b"two", b"three", b"hi alice"] {
        assert!(
            !payloads
                .iter()
                .any(|p| p.windows(plaintext.len()).any(|w| w == plaintext)),
            "server stored plaintext {:?}",
            String::from_utf8_lossy(plaintext)
        );
    }
}

#[tokio::test]
async fn a_device_catches_up_across_several_pages() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let mut bob = user(&server, "Bob").await;
    bob.publish_key_packages(1).await.unwrap();
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    bob.accept_invites().await.unwrap();

    // More than one page (the server returns at most 500 events per request).
    for i in 0..620 {
        alice.send(channel, format!("m{i}").as_bytes()).await.unwrap();
    }
    let got = bob.sync(channel).await.unwrap();
    assert_eq!(got.len(), 620);
    assert_eq!(got.last().unwrap().body, b"m619");
}

#[tokio::test]
async fn concurrent_commits_are_ordered_and_old_epoch_messages_are_refused() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let mut bob = user(&server, "Bob").await;
    let carol = user(&server, "Carol").await;
    let dave = user(&server, "Dave").await;
    for c in [&bob, &carol, &dave] {
        c.publish_key_packages(1).await.unwrap();
    }

    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    bob.accept_invites().await.unwrap();

    // Bob commits first. Alice then adds Dave from the same starting epoch;
    // add_device syncs first, so Alice applies Bob's commit and hers takes the next epoch.
    let staged = alice.device().epoch(channel).unwrap();
    bob.add_device(channel, carol.device().id()).await.unwrap();
    alice.add_device(channel, dave.device().id()).await.unwrap();
    assert_eq!(alice.device().epoch(channel).unwrap(), staged + 2);
    assert_eq!(alice.device().member_count(channel).unwrap(), 4);

    // A message encrypted in an old epoch is refused instead of landing out of order.
    let old = bob.device().epoch(channel).unwrap();
    match bob.send(channel, b"late").await {
        Err(Error::StaleEpoch { current_epoch, .. }) => assert_eq!(current_epoch, old + 1),
        other => panic!("expected StaleEpoch, got {other:?}"),
    }
    bob.sync(channel).await.unwrap();
    bob.send(channel, b"late").await.unwrap();
    let got = alice.sync(channel).await.unwrap();
    assert_eq!(bodies(&got), vec![b"late".as_slice()]);
}

#[tokio::test]
async fn server_rejects_a_commit_built_on_an_old_epoch_and_the_device_recovers() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let bob = user(&server, "Bob").await;
    let dave = user(&server, "Dave").await;
    bob.publish_key_packages(1).await.unwrap();
    dave.publish_key_packages(1).await.unwrap();
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    alice.add_device(channel, dave.device().id()).await.unwrap(); // channel is now at epoch 2

    // Bob (a member) posts a commit staged at epoch 0: the server must refuse it.
    let mut stale = Device::new().unwrap();
    stale.create_channel(channel).unwrap();
    let carol = Device::new().unwrap();
    let pending = stale
        .add_member(channel, &carol.key_packages(1).unwrap()[0])
        .unwrap();
    assert_eq!(pending.epoch, 0);

    let resp: AppendResponse = reqwest::Client::new()
        .post(format!("{}/v1/channels/{channel}/events", server.url))
        .bearer_auth(bob.session_token())
        .header(DEVICE_HEADER, bob.device().id().to_string())
        .json(&AppendRequest {
            epoch: pending.epoch,
            kind: EventKind::Commit,
            idempotency_key: uuid::Uuid::new_v4(),
            payload: Blob(pending.commit),
            adds: vec![],
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        matches!(resp, AppendResponse::StaleEpoch { current_epoch: 2 }),
        "{resp:?}"
    );

    // The loser drops its staged commit and can stage a new one.
    stale.discard_commit(channel).unwrap();
    assert_eq!(stale.epoch(channel).unwrap(), 0);
    assert!(
        stale
            .add_member(channel, &carol.key_packages(1).unwrap()[0])
            .is_ok()
    );
}
