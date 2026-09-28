//! Email one-time codes, the directory and per-user device lists.

use anarchy_core::{Client, Device, Error, oidc};
use anarchy_testkit::{TestOptions, TestServer};

fn status<T: std::fmt::Debug>(r: Result<T, Error>) -> u16 {
    match r {
        Ok(_) => 200,
        Err(Error::Api { status, .. }) => status,
        Err(e) => panic!("unexpected error: {e}"),
    }
}

async fn email_user(server: &TestServer, email: &str) -> Client {
    Client::request_email_code(&server.url, email).await.unwrap();
    let code = server
        .mailbox
        .last_code(&email.trim().to_lowercase())
        .expect("a code was emailed");
    let session = Client::login_with_email_code(&server.url, email, &code)
        .await
        .unwrap();
    let client = Client::from_session(&server.url, session, Device::new().unwrap());
    client.register_device().await.unwrap();
    client
}

#[tokio::test]
async fn a_work_address_signs_in_with_an_emailed_code() {
    let server = TestServer::start().await;
    let config = oidc::workspace_config(&server.url).await.unwrap();
    assert!(config.email_enabled);

    let maya = email_user(&server, "Maya@Northwind.org").await;
    assert!(!maya.session().is_guest);
    // Same address later: same person, whatever the case.
    let again = email_user(&server, "maya@northwind.org ").await;
    assert_eq!(again.user_id(), maya.user_id());
    let me = maya
        .directory()
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.user_id == maya.user_id())
        .unwrap();
    assert_eq!(me.display_name.as_deref(), Some("maya"));
    assert_eq!(me.email.as_deref(), Some("maya@northwind.org"));
}

#[tokio::test]
async fn only_allowed_domains_get_a_code() {
    let server = TestServer::start().await;
    assert_eq!(
        status(Client::request_email_code(&server.url, "eve@gmail.com").await),
        403
    );
    assert_eq!(
        status(Client::request_email_code(&server.url, "not-an-address").await),
        400
    );
    assert_eq!(server.mailbox.count(), 0, "nothing sent");
}

#[tokio::test]
async fn wrong_codes_are_limited() {
    let server = TestServer::start().await;
    Client::request_email_code(&server.url, "leo@northwind.org")
        .await
        .unwrap();
    let right = server.mailbox.last_code("leo@northwind.org").unwrap();
    let wrong = if right == "000000" { "111111" } else { "000000" };
    for _ in 0..5 {
        assert_eq!(
            status(Client::login_with_email_code(&server.url, "leo@northwind.org", wrong).await),
            401
        );
    }
    // Five wrong tries burn the code: even the right one no longer works.
    assert_eq!(
        status(Client::login_with_email_code(&server.url, "leo@northwind.org", &right).await),
        401
    );
}

#[tokio::test]
async fn codes_are_single_use_and_resends_are_throttled() {
    let server = TestServer::start().await;
    Client::request_email_code(&server.url, "ana@northwind.org")
        .await
        .unwrap();
    assert_eq!(
        status(Client::request_email_code(&server.url, "ana@northwind.org").await),
        429,
        "wait 30 s"
    );
    let code = server.mailbox.last_code("ana@northwind.org").unwrap();
    // Spaces and dashes typed by people are fine.
    let typed = format!("{} {}", &code[..3], &code[3..]);
    assert_eq!(
        status(Client::login_with_email_code(&server.url, "ana@northwind.org", &typed).await),
        200
    );
    assert_eq!(
        status(Client::login_with_email_code(&server.url, "ana@northwind.org", &code).await),
        401,
        "used"
    );
}

#[tokio::test]
async fn sign_in_methods_can_be_turned_off() {
    let server = TestServer::start_with(TestOptions {
        sso: false,
        email: false,
        guests: false,
        open: false,
    })
    .await;
    let config = oidc::workspace_config(&server.url).await.unwrap();
    assert_eq!(
        (config.issuer, config.email_enabled, config.guests_enabled),
        (None, false, false)
    );
    assert!(matches!(
        oidc::begin(&oidc::workspace_config(&server.url).await.unwrap()).await,
        Err(Error::SignIn(_))
    ));
    assert_eq!(
        status(Client::request_email_code(&server.url, "maya@northwind.org").await),
        403
    );
    assert_eq!(
        status(Client::login_with_id_token(&server.url, &server.idp.id_token("maya", "Maya")).await),
        403
    );
}

#[tokio::test]
async fn members_see_the_directory_and_their_own_devices() {
    let server = TestServer::start().await;
    let alice = email_user(&server, "alice@northwind.org").await;
    let phone = email_user(&server, "alice@northwind.org").await; // a second device
    let bob = email_user(&server, "bob@northwind.org").await;

    let people = alice.directory().await.unwrap();
    let a = people.iter().find(|p| p.user_id == alice.user_id()).unwrap();
    assert_eq!(a.devices.len(), 2);
    assert!(people.iter().any(|p| p.user_id == bob.user_id()));

    alice.revoke_device(phone.device().id()).await.unwrap();
    let mine = alice.my_devices().await.unwrap();
    assert_eq!(mine.len(), 2);
    assert!(
        mine.iter()
            .any(|d| d.device_id == phone.device().id() && d.revoked)
    );
    let a = alice
        .directory()
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.user_id == alice.user_id())
        .unwrap();
    assert_eq!(
        a.devices,
        vec![alice.device().id()],
        "revoked devices can't be added to channels"
    );

    // Guests can't browse who works here.
    let invite = alice
        .create_invite(std::time::Duration::from_secs(600), 1)
        .await
        .unwrap();
    let guest = Client::join_as_guest(&server.url, &invite.code, "Visitor", Device::new().unwrap())
        .await
        .unwrap();
    assert_eq!(status(guest.directory().await), 403);
}

#[tokio::test]
async fn member_lists_carry_names() {
    let server = TestServer::start().await;
    let mut alice = email_user(&server, "alice@northwind.org").await;
    let channel = alice.create_channel().await.unwrap();
    let members = alice.members(channel).await.unwrap();
    assert_eq!(members[0].display_name.as_deref(), Some("alice"));
    assert!(!members[0].is_guest);
}
