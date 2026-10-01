//! Personal accounts: handles, anonymous sign-up, spaces and direct conversations.

use std::time::Duration;

use anarchy_core::{Client, Content, Device, Error, Trust};
use anarchy_proto::{DmPolicy, ProfileUpdate, SpaceKind};
use anarchy_testkit::{TestOptions, TestServer};

fn status<T: std::fmt::Debug>(r: Result<T, Error>) -> u16 {
    match r {
        Ok(_) => 200,
        Err(Error::Api { status, .. }) => status,
        Err(e) => panic!("unexpected error: {e}"),
    }
}

async fn open_server() -> TestServer {
    TestServer::start_with(TestOptions {
        open: true,
        // Asked for, but an open server turns guests off (they'd belong to no space).
        guests: true,
        ..TestOptions::default()
    })
    .await
}

async fn ready(server: &TestServer, session: anarchy_proto::Session) -> Client {
    let client = Client::from_session(&server.url, session, Device::new().unwrap());
    client.register_device().await.unwrap();
    client.publish_key_packages(3).await.unwrap();
    client
}

async fn email_user(server: &TestServer, email: &str) -> Client {
    Client::request_email_code(&server.url, email).await.unwrap();
    let code = server.mailbox.last_code(email).unwrap();
    let session = Client::login_with_email_code(&server.url, email, &code)
        .await
        .unwrap();
    ready(server, session).await
}

async fn anon(server: &TestServer, name: &str) -> Client {
    let session = Client::login_anonymously(&server.url, Some(name)).await.unwrap();
    ready(server, session).await
}

fn text(body: &[u8]) -> String {
    Content::decode(body).text_body().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn every_account_gets_a_handle_and_can_change_its_username() {
    let server = open_server().await;
    let maya = email_user(&server, "maya.chen@example.com").await;
    let me = maya.me().await.unwrap();
    assert_eq!(me.username, "maya.chen");
    assert!((1..=9999).contains(&me.tag));
    assert!(!me.onboarded && !me.is_anonymous);

    // A new name keeps the tag when it's free under that name.
    let renamed = maya
        .update_me(&ProfileUpdate {
            username: Some("Maya".into()),
            display_name: Some("Maya Chen".into()),
            color: Some("ocean".into()),
            avatar: Some("🌊".into()),
            onboarded: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!((renamed.username.as_str(), renamed.tag), ("maya", me.tag));
    assert_eq!(renamed.avatar.as_deref(), Some("🌊"));
    assert!(renamed.onboarded);

    // Someone else taking "maya" gets a different tag, never a duplicate handle.
    let other = email_user(&server, "maya@example.org").await;
    let theirs = other
        .update_me(&ProfileUpdate {
            username: Some("maya".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(theirs.username, "maya");
    assert_ne!(theirs.tag, renamed.tag);

    for bad in ["a", ".maya", "ma..ya", "maya chen", "maya!"] {
        let r = maya
            .update_me(&ProfileUpdate {
                username: Some(bad.into()),
                ..Default::default()
            })
            .await;
        assert_eq!(status(r), 400, "{bad}");
    }
    let bad_colour = maya
        .update_me(&ProfileUpdate {
            color: Some("hotpink".into()),
            ..Default::default()
        })
        .await;
    assert_eq!(status(bad_colour), 400);

    // A sidekick: set, refused when malformed, cleared with an empty name.
    let sk = |name: &str, look: &str| ProfileUpdate {
        sidekick: Some(anarchy_proto::Sidekick {
            name: name.into(),
            look: look.into(),
        }),
        ..Default::default()
    };
    let me = maya.update_me(&sk("Pip", "spark-summer")).await.unwrap();
    assert_eq!(
        me.sidekick.as_ref().map(|s| (s.name.as_str(), s.look.as_str())),
        Some(("Pip", "spark-summer"))
    );
    assert_eq!(status(maya.update_me(&sk("Pip", "<svg>")).await), 400);
    let me = maya
        .update_me(&sk("Pip", "s2.case.stern.b07150.110.90.-4.a"))
        .await
        .unwrap();
    assert_eq!(me.sidekick.unwrap().look, "s2.case.stern.b07150.110.90.-4.a");
    assert_eq!(
        status(
            maya.update_me(&sk("Pip", "s2.case.stern.B07150.110.90.-4.a"))
                .await
        ),
        400
    );
    assert_eq!(
        status(
            maya.update_me(&sk("Pip", "s2.case.stern.b07150.400.90.0.a"))
                .await
        ),
        400
    );
    assert_eq!(
        status(maya.update_me(&sk(&"x".repeat(25), "orb-ocean")).await),
        400
    );
    assert!(maya.update_me(&sk("", "")).await.unwrap().sidekick.is_none());
}

#[tokio::test]
async fn anonymous_accounts_only_on_open_servers() {
    let open = open_server().await;
    let ghost = anon(&open, "Ghost").await;
    let me = ghost.me().await.unwrap();
    assert!(me.is_anonymous);
    assert_eq!(me.display_name, "Ghost");
    assert_eq!(me.email, None);

    let config = anarchy_core::oidc::workspace_config(&open.url).await.unwrap();
    assert!(config.open_signup && config.anonymous_enabled && !config.guests_enabled);

    let company = TestServer::start().await;
    assert_eq!(status(Client::login_anonymously(&company.url, None).await), 403);
}

#[tokio::test]
async fn direct_conversations_follow_the_receivers_privacy_setting() {
    let server = open_server().await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let mut tomas = email_user(&server, "tomas@example.com").await;
    let t = tomas.me().await.unwrap();

    // Default: only people who share a space. Strangers get the same answer as for
    // a handle that doesn't exist.
    let refused = maya.start_dm(&t.username, t.tag).await;
    assert_eq!(status(refused), 403);
    assert_eq!(status(maya.start_dm("nobody", 1234).await), 403);
    assert!(
        maya.device().channels().is_empty(),
        "refused attempts leave nothing behind"
    );

    tomas
        .update_me(&ProfileUpdate {
            dm_policy: Some(DmPolicy::Anyone),
            ..Default::default()
        })
        .await
        .unwrap();
    let (dm, peer, skipped) = maya.start_dm(&t.username, t.tag).await.unwrap();
    assert_eq!(peer.user_id, tomas.user_id());
    assert_eq!(peer.email, None, "handles never reveal email addresses");
    assert!(skipped.is_empty());

    maya.send_content(dm, &Content::text("hi tomas")).await.unwrap();
    tomas.accept_invites().await.unwrap();
    let got = tomas.sync_and_store(dm).await.unwrap();
    assert_eq!(
        got.iter().map(|d| text(&d.body)).collect::<Vec<_>>(),
        ["hi tomas"]
    );

    // Both see it as a DM with the other person.
    let metas = tomas.channel_metas().await.unwrap();
    let meta = metas.iter().find(|m| m.id == dm).unwrap();
    assert_eq!(meta.kind, anarchy_proto::ChannelKind::Dm);
    assert_eq!(meta.peer.as_ref().unwrap().user_id, maya.user_id());

    // Asking again, from either side, finds the same conversation. An existing
    // conversation isn't blocked by Maya's "spaces only" setting.
    let m = maya.me().await.unwrap();
    let (from_tomas, _, _) = tomas.start_dm(&m.username, m.tag).await.unwrap();
    assert_eq!(from_tomas, dm);
    let (again, _, _) = maya.start_dm(&t.username, t.tag).await.unwrap();
    assert_eq!(again, dm);

    // Nobody else can be added to a DM.
    let carol = email_user(&server, "carol@example.com").await;
    let add = maya.add_device(dm, carol.device().id()).await;
    assert_eq!(status(add), 400);
}

#[tokio::test]
async fn humans_only_refuses_agents() {
    let server = open_server().await;
    let mut agent = email_user(&server, "agent@example.com").await;
    let maya = email_user(&server, "maya@example.com").await;
    sqlx::query("UPDATE users SET is_agent = true WHERE id = $1")
        .bind(agent.user_id())
        .execute(&server.db)
        .await
        .unwrap();
    let m = maya
        .update_me(&ProfileUpdate {
            dm_policy: Some(DmPolicy::Anyone),
            dm_humans_only: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(status(agent.start_dm(&m.username, m.tag).await), 403);
    maya.update_me(&ProfileUpdate {
        dm_humans_only: Some(false),
        ..Default::default()
    })
    .await
    .unwrap();
    assert!(agent.start_dm(&m.username, m.tag).await.is_ok());
}

#[tokio::test]
async fn spaces_scope_who_you_see_and_who_can_be_added() {
    let server = open_server().await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let tomas = email_user(&server, "tomas@example.com").await;
    let stranger = email_user(&server, "eve@example.com").await;

    let space = maya
        .create_space("Studio Chen", SpaceKind::Freelance)
        .await
        .unwrap();
    assert_eq!(space.role, "owner");
    assert_eq!(space.members, 1);

    // A channel needs a space on an open server.
    assert_eq!(status(maya.create_channel().await), 400);
    let channel = maya
        .create_named_channel_in(Some(space.id), "clients", "", Trust::Sealed)
        .await
        .unwrap();

    // Not in the space yet: invisible and can't be added.
    let seen: Vec<_> = maya
        .directory()
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.user_id)
        .collect();
    assert!(!seen.contains(&tomas.user_id()) && !seen.contains(&stranger.user_id()));
    assert_eq!(status(maya.add_device(channel, tomas.device().id()).await), 400);

    let invite = maya
        .create_space_invite(space.id, Duration::from_secs(3600), 5)
        .await
        .unwrap();
    let joined = tomas.join_space(&invite.code).await.unwrap();
    assert_eq!((joined.id, joined.members), (space.id, 2));
    // Joining twice is harmless and doesn't use up the invite.
    tomas.join_space(&invite.code).await.unwrap();

    let in_space = maya.directory_in(space.id).await.unwrap();
    assert!(in_space.iter().any(|p| p.user_id == tomas.user_id()));
    assert!(
        in_space.iter().all(|p| p.email.is_none()),
        "no emails outside company servers"
    );
    assert!(maya.add_user(channel, tomas.user_id()).await.unwrap().is_empty());

    // Outsiders can't read the space or create channels in it.
    assert_eq!(status(stranger.directory_in(space.id).await), 404);
    let mut stranger = stranger;
    assert_eq!(status(stranger.create_channel_in(Some(space.id)).await), 404);
    assert_eq!(status(stranger.join_space("not-a-code").await), 403);
    assert_eq!(stranger.spaces().await.unwrap().len(), 0);
    assert_eq!(tomas.spaces().await.unwrap()[0].name, "Studio Chen");

    // Owners rename; members and outsiders can't.
    assert_eq!(
        maya.rename_space(space.id, "Chen Studio").await.unwrap().name,
        "Chen Studio"
    );
    assert_eq!(status(tomas.rename_space(space.id, "Mine now").await), 403);
    assert_eq!(status(stranger.rename_space(space.id, "Mine now").await), 404);
    assert_eq!(status(maya.rename_space(space.id, "  ").await), 400);
    assert_eq!(tomas.spaces().await.unwrap()[0].name, "Chen Studio");

    // The last owner can't leave; a member can, and then sees nothing of it.
    assert_eq!(status(maya.leave_space(space.id).await), 400);
    tomas.leave_space(space.id).await.unwrap();
    assert!(tomas.spaces().await.unwrap().is_empty());
    assert_eq!(status(tomas.directory_in(space.id).await), 404);
    assert_eq!(maya.spaces().await.unwrap()[0].members, 1);
}

#[tokio::test]
async fn company_servers_put_everyone_in_the_organisations_space() {
    let server = TestServer::start().await;
    let maya = email_user(&server, "maya@northwind.org").await;
    let spaces = maya.spaces().await.unwrap();
    assert_eq!(spaces.len(), 1);
    assert!(spaces[0].is_default);
    assert_eq!(spaces[0].name, "Northwind");
    assert_eq!(spaces[0].kind, SpaceKind::Company);
}
