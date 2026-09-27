//! Device state survives restarts, is encrypted at rest, and refuses the wrong key.

use std::path::PathBuf;

use anarchy_core::{Client, Device, Error};
use anarchy_testkit::TestServer;

struct TempFile(PathBuf);

impl TempFile {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("anarchy-device-{}.db", uuid::Uuid::new_v4())))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

const KEY: [u8; 32] = [7; 32];

async fn sign_in(server: &TestServer, name: &str, device: Device) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    Client::sign_in(&server.url, &token, device).await.unwrap()
}

#[tokio::test]
async fn a_device_restarts_and_carries_on() {
    let server = TestServer::start().await;
    let file = TempFile::new();

    let mut alice = sign_in(&server, "Alice", Device::create(&file.0, &KEY).unwrap()).await;
    let mut bob = sign_in(&server, "Bob", Device::new().unwrap()).await;
    bob.publish_key_packages(1).await.unwrap();
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob.device().id()).await.unwrap();
    bob.accept_invites().await.unwrap();
    bob.send(channel, b"before restart").await.unwrap();
    assert_eq!(alice.sync(channel).await.unwrap().len(), 1);
    let alice_id = alice.device().id();
    let epoch = alice.device().epoch(channel).unwrap();
    let cursor = alice.cursor(channel).unwrap();
    drop(alice);

    // Restart: same file, same key, a fresh session.
    let mut alice = sign_in(&server, "Alice", Device::open(&file.0, &KEY).unwrap()).await;
    assert_eq!(alice.device().id(), alice_id);
    assert_eq!(alice.device().channels(), vec![channel]);
    assert_eq!(alice.device().epoch(channel).unwrap(), epoch);
    assert_eq!(
        alice.cursor(channel).unwrap(),
        cursor,
        "cursor restored, so nothing is replayed"
    );

    // Only new messages arrive, and both directions still work.
    bob.send(channel, b"after restart").await.unwrap();
    let got = alice.sync(channel).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].body, b"after restart");
    alice.send(channel, b"still here").await.unwrap();
    assert_eq!(bob.sync(channel).await.unwrap()[0].body, b"still here");
}

#[tokio::test]
async fn key_packages_published_before_a_restart_still_work() {
    let server = TestServer::start().await;
    let file = TempFile::new();
    let bob = sign_in(&server, "Bob", Device::create(&file.0, &KEY).unwrap()).await;
    bob.publish_key_packages(1).await.unwrap();
    let bob_id = bob.device().id();
    drop(bob);

    // Alice adds Bob while he's offline; the Welcome is encrypted to the key package's
    // private key, which must have been saved to disk.
    let mut alice = sign_in(&server, "Alice", Device::new().unwrap()).await;
    let channel = alice.create_channel().await.unwrap();
    alice.add_device(channel, bob_id).await.unwrap();
    alice.send(channel, b"welcome back").await.unwrap();

    let mut bob = sign_in(&server, "Bob", Device::open(&file.0, &KEY).unwrap()).await;
    assert_eq!(bob.accept_invites().await.unwrap(), vec![channel]);
    assert_eq!(bob.sync(channel).await.unwrap()[0].body, b"welcome back");
}

#[test]
fn the_wrong_key_is_refused() {
    let file = TempFile::new();
    drop(Device::create(&file.0, &KEY).unwrap());
    assert!(matches!(Device::open(&file.0, &[8; 32]), Err(Error::WrongKey)));
    assert!(Device::open(&file.0, &KEY).is_ok());
}

#[test]
fn the_database_file_is_encrypted() {
    let file = TempFile::new();
    let device = Device::create(&file.0, &KEY).unwrap();
    let public_key = device.signature_public_key();
    let id = device.id();
    drop(device);

    let bytes = std::fs::read(&file.0).unwrap();
    assert!(
        !bytes.starts_with(b"SQLite format 3\0"),
        "plain SQLite header found"
    );
    for secret in [public_key.as_slice(), id.as_bytes().as_slice()] {
        assert!(
            !bytes.windows(secret.len()).any(|w| w == secret),
            "device data readable on disk"
        );
    }
}

#[test]
fn create_refuses_to_overwrite_an_existing_device() {
    let file = TempFile::new();
    drop(Device::create(&file.0, &KEY).unwrap());
    assert!(matches!(Device::create(&file.0, &KEY), Err(Error::Storage(_))));
}
