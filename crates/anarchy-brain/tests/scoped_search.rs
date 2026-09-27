//! The Brain must never put content in front of someone who couldn't already read it.

use anarchy_brain::{Brain, Error, Scope};
use anarchy_core::{Client, Device};
use anarchy_testkit::{TestServer, fresh_database};

async fn user(server: &TestServer, name: &str) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, Device::new().unwrap())
        .await
        .unwrap()
}

fn channels_of(hits: &[anarchy_brain::Hit]) -> Vec<uuid::Uuid> {
    let mut c: Vec<_> = hits.iter().map(|h| h.channel).collect();
    c.sort();
    c.dedup();
    c
}

#[tokio::test]
async fn answers_are_scoped_to_their_audience() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await; // on the board
    let bob = user(&server, "Bob").await; // not on the board
    let brain_client = user(&server, "Brain").await;
    for c in [&bob, &brain_client] {
        c.publish_key_packages(4).await.unwrap();
    }
    let brain_id = brain_client.device().id();
    let mut brain = Brain::new(brain_client, fresh_database().await).await.unwrap();

    // #general: Alice, Bob, Brain. #board: Alice, Brain. #hr: Alice only (no Brain).
    let general = alice.create_channel().await.unwrap();
    alice.add_device(general, bob.device().id()).await.unwrap();
    alice.add_device(general, brain_id).await.unwrap();
    let board = alice.create_channel().await.unwrap();
    alice.add_device(board, brain_id).await.unwrap();
    let hr = alice.create_channel().await.unwrap();

    alice.send(general, b"Acme demo is on Friday").await.unwrap();
    alice
        .send(board, b"Acme acquisition: offer capped at 40 million")
        .await
        .unwrap();
    alice
        .send(hr, b"Acme salary bands for the new team")
        .await
        .unwrap();

    let report = brain.ingest().await.unwrap();
    assert_eq!(
        report.messages, 2,
        "the Brain only reads channels it was added to"
    );
    let mut joined = report.joined.clone();
    joined.sort();
    let mut expected = vec![general, board];
    expected.sort();
    assert_eq!(joined, expected);

    // Bob, privately: only #general.
    let hits = brain
        .search(Scope::AskedBy(bob.user_id()), "acme", 10)
        .await
        .unwrap();
    assert_eq!(channels_of(&hits), vec![general]);
    assert!(hits.iter().all(|h| !h.body.contains("40 million")));

    // Alice, privately: #general and #board. Never #hr, which the Brain was never in.
    let hits = brain
        .search(Scope::AskedBy(alice.user_id()), "acme", 10)
        .await
        .unwrap();
    let mut both = vec![general, board];
    both.sort();
    assert_eq!(channels_of(&hits), both);
    assert!(hits.iter().all(|h| !h.body.contains("salary")));

    // Alice asks in #general: Bob will see the answer, so #board is out of scope.
    let hits = brain.search(Scope::PostingTo(general), "acme", 10).await.unwrap();
    assert_eq!(channels_of(&hits), vec![general]);

    // Asked in #board: everyone there is also in #general, so both are in scope.
    let hits = brain.search(Scope::PostingTo(board), "acme", 10).await.unwrap();
    assert_eq!(channels_of(&hits), both);

    // The Brain can't answer in a channel it isn't part of.
    assert!(
        matches!(brain.search(Scope::PostingTo(hr), "acme", 10).await, Err(Error::NotInChannel(c)) if c == hr)
    );

    // Hits name the author.
    let hit = &brain
        .search(Scope::AskedBy(alice.user_id()), "offer", 10)
        .await
        .unwrap()[0];
    assert_eq!(hit.sender, Some(alice.user_id()));
}

#[tokio::test]
async fn joining_a_channel_widens_scope_on_the_next_ingest() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice").await;
    let bob = user(&server, "Bob").await;
    let brain_client = user(&server, "Brain").await;
    for c in [&bob, &brain_client] {
        c.publish_key_packages(4).await.unwrap();
    }
    let brain_id = brain_client.device().id();
    let mut brain = Brain::new(brain_client, fresh_database().await).await.unwrap();

    let board = alice.create_channel().await.unwrap();
    alice.add_device(board, brain_id).await.unwrap();
    alice
        .send(board, b"Roadmap freeze until the audit")
        .await
        .unwrap();
    brain.ingest().await.unwrap();
    assert!(
        brain
            .search(Scope::AskedBy(bob.user_id()), "roadmap", 10)
            .await
            .unwrap()
            .is_empty()
    );

    alice.add_device(board, bob.device().id()).await.unwrap();
    brain.ingest().await.unwrap();
    let hits = brain
        .search(Scope::AskedBy(bob.user_id()), "roadmap", 10)
        .await
        .unwrap();
    assert_eq!(channels_of(&hits), vec![board]);
}
