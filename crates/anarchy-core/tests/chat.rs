//! Named channels, adding people, and local history.

use anarchy_core::{Client, Content, Device, Trust};
use anarchy_testkit::TestServer;

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

fn texts(client: &Client, channel: uuid::Uuid) -> Vec<String> {
    client
        .device()
        .messages(channel, 100)
        .unwrap()
        .iter()
        .filter_map(|m| Content::decode(&m.content).text_body().map(str::to_owned))
        .collect()
}

#[tokio::test]
async fn a_named_channel_with_people_and_history() {
    let server = TestServer::start().await;
    let mut alice = email_user(&server, "alice@northwind.org").await;
    let mut bob = email_user(&server, "bob@northwind.org").await;

    let channel = alice
        .create_named_channel("design-crit", "Fridays at 4", Trust::Sealed)
        .await
        .unwrap();
    assert_eq!(
        alice.channel_info(channel).unwrap(),
        Some(("design-crit".into(), "Fridays at 4".into(), Trust::Sealed))
    );
    assert!(alice.add_user(channel, bob.user_id()).await.unwrap().is_empty());
    alice
        .send_content(channel, &Content::text("first draft is up"))
        .await
        .unwrap();

    bob.accept_invites().await.unwrap();
    bob.sync_and_store(channel).await.unwrap();
    // Bob joined after the name was set; add_user re-sent it in the epoch he can read.
    assert_eq!(bob.channel_info(channel).unwrap().unwrap().0, "design-crit");
    assert_eq!(texts(&bob, channel), vec!["first draft is up"]);

    bob.send_content(channel, &Content::text("looks good"))
        .await
        .unwrap();
    alice.sync_and_store(channel).await.unwrap();
    assert_eq!(texts(&alice, channel), vec!["first draft is up", "looks good"]);
    assert_eq!(
        texts(&bob, channel),
        vec!["first draft is up", "looks good"],
        "own messages kept too"
    );

    // Renaming is just a newer ChannelInfo.
    alice
        .send_content(
            channel,
            &Content::ChannelInfo {
                name: "crit".into(),
                topic: String::new(),
                trust: Trust::Sealed,
            },
        )
        .await
        .unwrap();
    bob.sync_and_store(channel).await.unwrap();
    assert_eq!(bob.channel_info(channel).unwrap().unwrap().0, "crit");

    // The server never saw the channel's name.
    let payloads = server.payloads(channel).await;
    assert!(payloads.iter().all(|p| !p.windows(6).any(|w| w == b"design")));

    // Removal takes the history with it.
    alice.remove_user(channel, bob.user_id()).await.unwrap();
    bob.sync_and_store(channel).await.unwrap();
    assert!(!bob.device().has_channel(channel));
    assert!(bob.device().messages(channel, 100).unwrap().is_empty());
}
