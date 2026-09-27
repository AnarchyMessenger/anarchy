//! Removing members and revoking lost devices.

use anarchy_core::{Client, Device, Error, Incoming};
use anarchy_proto::{AppendRequest, Blob, DEVICE_HEADER, EventKind, EventsPage};
use anarchy_testkit::TestServer;

async fn user(server: &TestServer, name: &str) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, Device::new().unwrap())
        .await
        .unwrap()
}

/// Alice, Bob and Carol in one channel, everyone synced.
async fn three_person_channel(server: &TestServer) -> (Client, Client, Client, uuid::Uuid) {
    let mut alice = user(server, "Alice").await;
    let mut bob = user(server, "Bob").await;
    let mut carol = user(server, "Carol").await;
    bob.publish_key_packages(2).await.unwrap();
    carol.publish_key_packages(1).await.unwrap();
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    alice.add_device(channel, carol.device().id()).await.unwrap();
    bob.accept_invites().await.unwrap();
    carol.accept_invites().await.unwrap();
    bob.sync(channel).await.unwrap();
    carol.sync(channel).await.unwrap();
    (alice, bob, carol, channel)
}

#[tokio::test]
async fn a_removed_member_learns_it_and_loses_access() {
    let server = TestServer::start().await;
    let (mut alice, mut bob, mut carol, channel) = three_person_channel(&server).await;

    alice.send(channel, b"before").await.unwrap();
    alice.remove_devices(channel, &[bob.device().id()]).await.unwrap();
    alice.send(channel, b"after bob left").await.unwrap();
    assert_eq!(alice.device().member_count(channel).unwrap(), 2);
    assert!(
        alice
            .members(channel)
            .await
            .unwrap()
            .iter()
            .all(|m| m.user_id != bob.user_id())
    );

    // Bob gets what was sent before his removal, sees the removal, and deletes the channel.
    let got = bob.sync(channel).await.unwrap();
    assert_eq!(
        got.iter().map(|m| m.body.as_slice()).collect::<Vec<_>>(),
        vec![b"before".as_slice()]
    );
    assert!(!bob.device().has_channel(channel));
    assert!(matches!(bob.sync(channel).await, Err(Error::UnknownChannel(_))));

    // The server serves him nothing past the removal and refuses his posts.
    let http = reqwest::Client::new();
    let page: EventsPage = http
        .get(format!("{}/v1/channels/{channel}/events?after=0", server.url))
        .bearer_auth(bob.session_token())
        .header(DEVICE_HEADER, bob.device().id().to_string())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let removal_seq = page.head;
    alice.sync(channel).await.unwrap(); // a sender's cursor only moves on sync
    let latest = alice.cursor(channel).unwrap();
    assert!(removal_seq < latest, "the channel moved on after the removal");
    assert_eq!(
        page.events.last().unwrap().seq,
        removal_seq,
        "the removal commit itself is served"
    );
    assert!(
        page.events.iter().all(|e| e.seq <= removal_seq),
        "nothing after the removal is served"
    );
    let status = http
        .post(format!("{}/v1/channels/{channel}/events", server.url))
        .bearer_auth(bob.session_token())
        .header(DEVICE_HEADER, bob.device().id().to_string())
        .json(&AppendRequest {
            epoch: 0,
            kind: EventKind::Application,
            idempotency_key: uuid::Uuid::new_v4(),
            payload: Blob(vec![0]),
            adds: vec![],
            removes: vec![],
        })
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404);

    // Carol carries on with Alice.
    let got = carol.sync(channel).await.unwrap();
    assert_eq!(got.last().unwrap().body, b"after bob left");
}

#[test]
fn a_removed_members_keys_cannot_decrypt_later_messages() {
    // Pure MLS, no server: Bob keeps his state from before the removal and is fed
    // a message sent after it. The removal commit rotated the keys, so he can't read it.
    let mut alice = Device::new().unwrap();
    let mut bob = Device::new().unwrap();
    let mut carol = Device::new().unwrap();
    let channel = uuid::Uuid::new_v4();
    alice.create_channel(channel).unwrap();
    let kp = bob.key_packages(1).unwrap().remove(0);
    let add_bob = alice.add_member(channel, &kp).unwrap();
    alice.confirm_commit(channel).unwrap();
    bob.join(&add_bob.welcome.unwrap()).unwrap();

    let kp = carol.key_packages(1).unwrap().remove(0);
    let add_carol = alice.add_member(channel, &kp).unwrap();
    alice.confirm_commit(channel).unwrap();
    carol.join(&add_carol.welcome.unwrap()).unwrap();
    bob.receive(channel, &add_carol.commit).unwrap(); // Bob sees Carol being added.

    let removal = alice.remove_members(channel, &[bob.id()]).unwrap();
    alice.confirm_commit(channel).unwrap();
    assert_eq!(
        carol.receive(channel, &removal.commit).unwrap(),
        Incoming::EpochAdvanced
    );
    let (_, secret) = carol.encrypt(channel, b"bob must not read this").unwrap();

    // Without the removal commit, Bob is an epoch behind and has no key.
    assert!(bob.receive(channel, &secret).is_err());
    // Processing the removal tells him he's out and deletes the group.
    assert_eq!(bob.receive(channel, &removal.commit).unwrap(), Incoming::Removed);
    assert!(!bob.has_channel(channel));
    assert!(matches!(
        bob.receive(channel, &secret),
        Err(Error::UnknownChannel(_))
    ));
}

#[tokio::test]
async fn a_removed_member_can_be_added_back() {
    let server = TestServer::start().await;
    let (mut alice, mut bob, _carol, channel) = three_person_channel(&server).await;
    alice.remove_devices(channel, &[bob.device().id()]).await.unwrap();
    bob.sync(channel).await.unwrap();
    assert!(!bob.device().has_channel(channel));

    bob.publish_key_packages(1).await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    alice.send(channel, b"welcome back").await.unwrap();
    assert_eq!(bob.accept_invites().await.unwrap(), vec![channel]);
    assert_eq!(
        bob.sync(channel).await.unwrap().last().unwrap().body,
        b"welcome back"
    );
}

#[tokio::test]
async fn members_cannot_remove_themselves_or_non_members() {
    let server = TestServer::start().await;
    let (mut alice, _bob, _carol, channel) = three_person_channel(&server).await;
    let outsider = user(&server, "Mallory").await;

    let own = alice.device().id();
    assert!(matches!(
        alice.remove_devices(channel, &[own]).await,
        Err(Error::Mls(_))
    ));
    assert!(matches!(
        alice.remove_devices(channel, &[outsider.device().id()]).await,
        Err(Error::Mls(_))
    ));
    assert_eq!(
        alice.device().member_count(channel).unwrap(),
        3,
        "nothing changed"
    );
}

#[tokio::test]
async fn a_lost_device_is_revoked_and_removed_from_its_channels() {
    let server = TestServer::start().await;
    let (mut alice, bob_laptop, mut carol, channel) = three_person_channel(&server).await;
    // Bob signs in on his phone and revokes the lost laptop.
    let bob_phone = user(&server, "Bob").await;
    assert_eq!(bob_phone.user_id(), bob_laptop.user_id());
    bob_phone.revoke_device(bob_laptop.device().id()).await.unwrap();

    // The laptop can no longer authenticate.
    match bob_laptop.members(channel).await {
        Err(Error::Api { status: 403, .. }) => {}
        other => panic!("expected 403, got {other:?}"),
    }
    // Only its owner can revoke a device.
    match alice.revoke_device(carol.device().id()).await {
        Err(Error::Api { status: 404, .. }) => {}
        other => panic!("expected 404, got {other:?}"),
    }

    // The server stops listing it; a member commits its removal from the MLS group.
    assert!(
        alice
            .members(channel)
            .await
            .unwrap()
            .iter()
            .all(|m| m.device_id != bob_laptop.device().id())
    );
    assert_eq!(
        alice.remove_revoked(channel).await.unwrap(),
        vec![bob_laptop.device().id()]
    );
    assert_eq!(alice.device().member_count(channel).unwrap(), 2);

    // Carol runs the same clean-up afterwards and finds nothing left to do.
    assert!(carol.remove_revoked(channel).await.unwrap().is_empty());
    assert_eq!(carol.device().member_count(channel).unwrap(), 2);
}
