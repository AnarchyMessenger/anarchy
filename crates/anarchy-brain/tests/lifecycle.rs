//! The Brain survives restarts, forgets channels it's removed from, and follows
//! membership changes.

use anarchy_brain::{Brain, Scope};
use anarchy_core::{Client, Device};
use anarchy_testkit::{TestServer, fresh_database};

async fn user(server: &TestServer, name: &str, device: Device) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, device).await.unwrap()
}

#[tokio::test]
async fn removing_the_brain_purges_what_it_learned_there() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice", Device::new().unwrap()).await;
    let brain_client = user(&server, "Brain", Device::new().unwrap()).await;
    brain_client.publish_key_packages(2).await.unwrap();
    let brain_id = brain_client.device().id();
    let mut brain = Brain::new(brain_client, fresh_database().await).await.unwrap();

    let board = alice.create_channel().await.unwrap();
    let general = alice.create_channel().await.unwrap();
    alice.add_device(board, brain_id).await.unwrap();
    alice.add_device(general, brain_id).await.unwrap();
    alice
        .send(board, b"Acme offer capped at 40 million")
        .await
        .unwrap();
    alice.send(general, b"Acme demo on Friday").await.unwrap();
    brain.ingest().await.unwrap();
    assert_eq!(
        brain
            .search(Scope::AskedBy(alice.user_id()), "acme", 10)
            .await
            .unwrap()
            .len(),
        2
    );

    // The board decides the Brain shouldn't be there.
    alice.remove_devices(board, &[brain_id]).await.unwrap();
    alice.send(board, b"Acme board minutes").await.unwrap();
    let report = brain.ingest().await.unwrap();
    assert_eq!(report.removed_from, vec![board]);

    let hits = brain
        .search(Scope::AskedBy(alice.user_id()), "acme", 10)
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].channel, general);
    assert!(matches!(
        brain.search(Scope::PostingTo(board), "acme", 10).await,
        Err(anarchy_brain::Error::NotInChannel(_))
    ));
}

#[tokio::test]
async fn removing_a_person_narrows_what_the_brain_shows_them() {
    let server = TestServer::start().await;
    let mut alice = user(&server, "Alice", Device::new().unwrap()).await;
    let bob = user(&server, "Bob", Device::new().unwrap()).await;
    let brain_client = user(&server, "Brain", Device::new().unwrap()).await;
    bob.publish_key_packages(1).await.unwrap();
    brain_client.publish_key_packages(1).await.unwrap();
    let brain_id = brain_client.device().id();
    let mut brain = Brain::new(brain_client, fresh_database().await).await.unwrap();

    let board = alice.create_channel().await.unwrap();
    alice.add_device(board, bob.device().id()).await.unwrap();
    alice.add_device(board, brain_id).await.unwrap();
    alice
        .send(board, b"Roadmap freeze until the audit")
        .await
        .unwrap();
    brain.ingest().await.unwrap();
    assert_eq!(
        brain
            .search(Scope::AskedBy(bob.user_id()), "roadmap", 10)
            .await
            .unwrap()
            .len(),
        1
    );

    alice.remove_user(board, bob.user_id()).await.unwrap();
    brain.ingest().await.unwrap();
    assert!(
        brain
            .search(Scope::AskedBy(bob.user_id()), "roadmap", 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn the_brain_restarts_without_losing_or_repeating_anything() {
    let server = TestServer::start().await;
    let path = std::env::temp_dir().join(format!("anarchy-brain-{}.db", uuid::Uuid::new_v4()));
    let key = [9u8; 32];
    let brain_db = fresh_database().await;

    let mut alice = user(&server, "Alice", Device::new().unwrap()).await;
    let brain_client = user(&server, "Brain", Device::create(&path, &key).unwrap()).await;
    brain_client.publish_key_packages(1).await.unwrap();
    let brain_id = brain_client.device().id();
    let mut brain = Brain::new(brain_client, brain_db.clone()).await.unwrap();

    let general = alice.create_channel().await.unwrap();
    alice.add_device(general, brain_id).await.unwrap();
    alice
        .send(general, b"Launch checklist is in the drive")
        .await
        .unwrap();
    assert_eq!(brain.ingest().await.unwrap().messages, 1);
    drop(brain);

    // Messages arrive while the Brain is down.
    alice.send(general, b"Launch moved to Tuesday").await.unwrap();

    let brain_client = user(&server, "Brain", Device::open(&path, &key).unwrap()).await;
    let mut brain = Brain::new(brain_client, brain_db).await.unwrap();
    let report = brain.ingest().await.unwrap();
    assert_eq!(report.messages, 1, "only the new message");
    assert!(report.joined.is_empty() && report.removed_from.is_empty());
    let hits = brain
        .search(Scope::AskedBy(alice.user_id()), "launch", 10)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);

    let _ = std::fs::remove_file(&path);
}
