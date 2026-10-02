//! A server-side sidekick reads only what its person let it, answers only them,
//! and loses a channel the moment its person does.

use anarchy_core::{Client, Content, Device};
use anarchy_proto::{ProfileUpdate, Sidekick};
use anarchy_sidekick::Host;
use anarchy_testkit::{SIDEKICK_HOST_TOKEN, TestServer};

async fn user(server: &TestServer, name: &str) -> Client {
    let token = server.idp.id_token(&name.to_lowercase(), name);
    let c = Client::sign_in(&server.url, &token, Device::new().unwrap())
        .await
        .unwrap();
    c.publish_key_packages(4).await.unwrap();
    c
}

fn texts(client: &Client, channel: anarchy_proto::ChannelId) -> Vec<String> {
    client
        .device()
        .messages(channel, 100)
        .unwrap()
        .iter()
        .filter_map(|m| Content::decode(&m.content).text_body().map(str::to_owned))
        .collect()
}

fn scratch() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("anarchy-sidekick-test-{}", uuid_like()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn uuid_like() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[tokio::test]
async fn a_sidekick_reads_only_what_its_person_shares_and_answers_only_them() {
    let server = TestServer::start().await;
    let mut maya = user(&server, "Maya").await;
    let mut bob = user(&server, "Bob").await;
    maya.update_me(&ProfileUpdate {
        sidekick: Some(Sidekick {
            name: "Pip".into(),
            look: "spark-summer".into(),
        }),
        ..Default::default()
    })
    .await
    .unwrap();

    let account = maya.enable_sidekick().await.unwrap();
    assert_eq!(
        maya.enable_sidekick().await.unwrap().user_id,
        account.user_id,
        "turning it on again is harmless"
    );
    let mut host = Host::new(&server.url, SIDEKICK_HOST_TOKEN, scratch(), [7; 32]);
    host.tick().await.unwrap();
    let sk = host.device_of(account.user_id).expect("the host started Pip");
    assert_eq!(maya.sidekick_account().await.unwrap().unwrap().devices, vec![sk]);

    // A wrong host token gets nothing.
    assert!(
        Client::host_agents(&server.url, "not-the-token-not-the-token-000000")
            .await
            .is_err()
    );

    let general = maya.create_channel().await.unwrap();
    maya.add_device(general, bob.device().id()).await.unwrap();
    bob.accept_invites().await.unwrap();

    // Only Maya can bring Pip in.
    assert!(
        bob.add_device(general, sk).await.is_err(),
        "someone else's sidekick"
    );
    maya.add_device(general, sk).await.unwrap();
    let r = host.tick().await.unwrap();
    assert_eq!(r.joined, vec![general]);

    bob.sync_and_store(general).await.unwrap();
    bob.send_content(general, &Content::text("Acme paid the deposit"))
        .await
        .unwrap();
    maya.sync_and_store(general).await.unwrap();
    maya.send_content(general, &Content::text("Acme invoice two is late"))
        .await
        .unwrap();

    // Nobody but Maya can talk to Pip.
    let pip = maya
        .members(general)
        .await
        .unwrap()
        .into_iter()
        .find(|m| m.agent_of == Some(maya.user_id()))
        .unwrap();
    assert!(pip.is_agent);
    // Everyone sees Pip drawn the way Maya designed it.
    assert_eq!(
        pip.sidekick.as_ref().map(|s| s.look.as_str()),
        Some("spark-summer")
    );
    assert_eq!(pip.presence, None, "agents have no presence");
    let (handle, tag) = (pip.username.clone().unwrap(), pip.tag.unwrap());
    assert!(bob.start_dm(&handle, tag).await.is_err());
    let (dm, ..) = maya.start_dm(&handle, tag).await.unwrap();
    maya.send_content(dm, &Content::text("anything about acme?"))
        .await
        .unwrap();
    let r = host.tick().await.unwrap();
    assert_eq!(r.joined, vec![dm]);
    assert_eq!(r.answered, 1);
    maya.sync_and_store(dm).await.unwrap();
    let reply = texts(&maya, dm).pop().unwrap();
    assert!(
        reply.contains("Acme paid the deposit") && reply.contains("Acme invoice two is late"),
        "{reply}"
    );
    assert!(reply.contains("Bob") && reply.contains("Maya"), "{reply}");

    // Memory: what Maya asks it to keep, listed, used in answers, and forgotten.
    let ask = |text: &'static str| Content::text(text);
    for q in [
        "remember that Acme pays on the 15th",
        "remember the Acme contact is Jonas",
        "what do you remember?",
    ] {
        maya.send_content(dm, &ask(q)).await.unwrap();
    }
    assert_eq!(host.tick().await.unwrap().answered, 3);
    maya.sync_and_store(dm).await.unwrap();
    let list = texts(&maya, dm).pop().unwrap();
    assert!(
        list.contains("1. Acme pays on the 15th") && list.contains("2. the Acme contact is Jonas"),
        "{list}"
    );
    maya.send_content(dm, &ask("when does acme pay?")).await.unwrap();
    host.tick().await.unwrap();
    maya.sync_and_store(dm).await.unwrap();
    assert!(
        texts(&maya, dm)
            .pop()
            .unwrap()
            .contains("From what you told me:\n• Acme pays on the 15th")
    );
    maya.send_content(dm, &ask("forget 1")).await.unwrap();
    maya.send_content(dm, &ask("what do you remember")).await.unwrap();
    host.tick().await.unwrap();
    maya.sync_and_store(dm).await.unwrap();
    let list = texts(&maya, dm).pop().unwrap();
    assert!(
        !list.contains("15th") && list.contains("1. the Acme contact is Jonas"),
        "{list}"
    );

    // Maya leaves: Pip is cut off before anyone removes it, and forgets the channel.
    bob.remove_user(general, maya.user_id()).await.unwrap();
    bob.send_content(general, &Content::text("Acme said after Maya left"))
        .await
        .unwrap();
    maya.send_content(dm, &Content::text("deposit?")).await.unwrap();
    let r = host.tick().await.unwrap();
    assert_eq!(r.forgot, vec![general]);
    maya.sync_and_store(dm).await.unwrap();
    let reply = texts(&maya, dm).pop().unwrap();
    assert!(reply.contains("can't read any channels"), "{reply}");
}
