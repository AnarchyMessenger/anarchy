//! Desks: a channel whose records are encrypted items, shared with newcomers.

use anarchy_core::{Client, Content, Device};
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

fn invoice(id: &str, amount: u32, status: &str) -> Content {
    Content::Item {
        id: id.into(),
        kind: "invoice".into(),
        data: json!({ "customer": "Acme", "amount": amount, "status": status }),
    }
}

#[tokio::test]
async fn a_desk_keeps_its_records_encrypted_and_shares_them_with_newcomers() {
    let server = TestServer::start_with(TestOptions {
        open: true,
        ..TestOptions::default()
    })
    .await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let mut tomas = email_user(&server, "tomas@example.com").await;
    let space = maya.create_space("Studio", SpaceKind::Freelance).await.unwrap();
    let invite = maya
        .create_space_invite(space.id, std::time::Duration::from_secs(600), 1)
        .await
        .unwrap();
    tomas.join_space(&invite.code).await.unwrap();

    let desk = maya
        .create_desk(Some(space.id), "Collections", "collections")
        .await
        .unwrap();
    assert_eq!(maya.desk_kind(desk).unwrap().as_deref(), Some("collections"));
    maya.send_content(desk, &invoice("inv-1", 1200, "sent"))
        .await
        .unwrap();
    maya.send_content(desk, &invoice("inv-2", 940, "sent"))
        .await
        .unwrap();
    maya.send_content(desk, &invoice("inv-1", 1200, "paid"))
        .await
        .unwrap();
    let items = maya.desk_items(desk).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].data["status"], "paid");

    // Tomás joins after all that. MLS won't let him read those messages, so the
    // desk re-shares its current state when he's added.
    assert!(maya.add_user(desk, tomas.user_id()).await.unwrap().is_empty());
    tomas.accept_invites().await.unwrap();
    tomas.sync_and_store(desk).await.unwrap();
    assert_eq!(tomas.desk_kind(desk).unwrap().as_deref(), Some("collections"));
    let his = tomas.desk_items(desk).unwrap();
    assert_eq!(
        his.iter()
            .map(|i| (&i.id[..], i.data["status"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        [("inv-1", "paid"), ("inv-2", "sent")]
    );

    // He updates one; Maya sees it.
    tomas
        .send_content(desk, &invoice("inv-2", 940, "paid"))
        .await
        .unwrap();
    maya.sync_and_store(desk).await.unwrap();
    assert!(
        maya.desk_items(desk)
            .unwrap()
            .iter()
            .all(|i| i.data["status"] == "paid")
    );

    // The server holds none of it in the clear.
    for payload in server.payloads(desk).await {
        let s = String::from_utf8_lossy(&payload);
        assert!(!s.contains("Acme") && !s.contains("Collections") && !s.contains("invoice"));
    }
}
