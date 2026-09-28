//! Drives: files encrypted on the device, chunks the server can't read.

use anarchy_core::{Client, Content, Device, Error};
use anarchy_proto::SpaceKind;
use anarchy_testkit::{TestOptions, TestServer};
use serde_json::json;

async fn email_user(server: &TestServer, email: &str) -> Client {
    Client::request_email_code(&server.url, email).await.unwrap();
    let code = server.mailbox.last_code(email).unwrap();
    let session = Client::login_with_email_code(&server.url, email, &code)
        .await
        .unwrap();
    let client = Client::from_session(&server.url, session, Device::new().unwrap());
    client.register_device().await.unwrap();
    client.publish_key_packages(3).await.unwrap();
    client
}

#[tokio::test]
async fn files_are_encrypted_before_upload_and_readable_only_by_members() {
    let server = TestServer::start_with(TestOptions {
        open: true,
        ..TestOptions::default()
    })
    .await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let mut tomas = email_user(&server, "tomas@example.com").await;
    let eve = email_user(&server, "eve@example.com").await;
    let space = maya.create_space("Studio", SpaceKind::Freelance).await.unwrap();
    let invite = maya
        .create_space_invite(space.id, std::time::Duration::from_secs(600), 1)
        .await
        .unwrap();
    tomas.join_space(&invite.code).await.unwrap();
    let drive = maya.create_desk(Some(space.id), "Files", "files").await.unwrap();

    // 9 MB: three chunks. A marker makes plaintext easy to spot in storage.
    let mut contract: Vec<u8> = b"CONFIDENTIAL-CONTRACT ".repeat(10);
    contract.extend((0..9_000_000u32).map(|i| (i % 253) as u8));
    let mut record = maya.upload_file(drive, &contract).await.unwrap();
    record["name"] = json!("contract.pdf");
    record["folder"] = json!("/Clients");
    maya.send_content(
        drive,
        &Content::Item {
            id: "f1".into(),
            kind: "file".into(),
            data: record.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(record["chunks"].as_array().unwrap().len(), 3);

    let stored: Vec<Vec<u8>> = sqlx::query_scalar("SELECT data FROM blobs")
        .fetch_all(&server.db)
        .await
        .unwrap();
    assert_eq!(stored.len(), 3);
    assert!(
        stored
            .iter()
            .all(|b| !b.windows(12).any(|w| w == b"CONFIDENTIAL"))
    );
    for p in server.payloads(drive).await {
        assert!(
            !String::from_utf8_lossy(&p).contains("contract.pdf"),
            "names are encrypted too"
        );
    }

    // Someone who isn't in the channel can't fetch the chunks, even with the record.
    assert!(matches!(
        eve.download_file(drive, &record).await,
        Err(Error::Api { status: 404, .. })
    ));

    // Tomás is added later; the snapshot gives him the record, keys included.
    maya.add_user(drive, tomas.user_id()).await.unwrap();
    tomas.accept_invites().await.unwrap();
    tomas.sync_and_store(drive).await.unwrap();
    let his = tomas.desk_items(drive).unwrap();
    assert_eq!(his[0].data["name"], "contract.pdf");
    assert_eq!(tomas.download_file(drive, &his[0].data).await.unwrap(), contract);

    // A server that swaps bytes gets caught.
    sqlx::query("UPDATE blobs SET data = set_byte(data, 100, get_byte(data, 100) # 1) WHERE id = (SELECT id FROM blobs LIMIT 1)")
        .execute(&server.db)
        .await
        .unwrap();
    assert!(maya.download_file(drive, &record).await.is_err());
}
