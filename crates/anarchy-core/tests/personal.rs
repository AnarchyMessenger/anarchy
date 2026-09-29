//! Personal desks: one person's agenda and notes, in no space, readable only
//! by their own devices.

use anarchy_core::{Client, Content, Device};
use anarchy_proto::ChannelKind;
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
async fn personal_desks_need_no_space_and_admit_nobody_else() {
    let server = TestServer::start_with(TestOptions {
        open: true,
        ..TestOptions::default()
    })
    .await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let tomas = email_user(&server, "tomas@example.com").await;

    // An open server has no default space; a personal desk doesn't need one.
    let notes = maya.create_personal_desk("Notes", "notes").await.unwrap();
    maya.send_content(
        notes,
        &Content::Item {
            id: "p1".into(),
            kind: "page".into(),
            data: json!({"title": "Ideas", "blocks": [{"type": "p", "text": "secret plan"}]}),
        },
    )
    .await
    .unwrap();
    assert_eq!(maya.desk_kind(notes).unwrap().as_deref(), Some("notes"));
    let metas = maya.channel_metas().await.unwrap();
    let meta = metas.iter().find(|m| m.id == notes).unwrap();
    assert_eq!(meta.kind, ChannelKind::Personal);
    assert!(meta.space.is_none());

    // Someone else's device can't be added, even by the owner.
    let err = maya.add_user(notes, tomas.session().user_id).await;
    assert!(err.is_err(), "adding another person to a personal desk must fail");
    let stored: Vec<Vec<u8>> = sqlx::query_scalar("SELECT payload FROM channel_events")
        .fetch_all(&server.db)
        .await
        .unwrap();
    assert!(!stored.iter().any(|p| p.windows(11).any(|w| w == b"secret plan")));
}
