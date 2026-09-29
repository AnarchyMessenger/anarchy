//! Pay links: a page for someone without an account, readable only with the
//! key in the link's fragment.

use anarchy_core::{Client, Device, Error};
use anarchy_proto::{PublicPayLink, SpaceKind};
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

fn in_days(days: u64) -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + days * 86_400_000
}

#[tokio::test]
async fn pay_links_are_sealed_trackable_and_revocable() {
    let server = TestServer::start_with(TestOptions {
        open: true,
        ..TestOptions::default()
    })
    .await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let eve = email_user(&server, "eve@example.com").await;
    let space = maya.create_space("Studio", SpaceKind::Freelance).await.unwrap();
    let desk = maya
        .create_desk(Some(space.id), "Collections", "collections")
        .await
        .unwrap();

    let page = json!({"from": "Studio Chen", "to": "Roux SARL", "number": "INV-1042", "amount": 184050,
        "pay": {"iban": "FR76 3000 6000 0112 3456 7890 189"}});
    let (id, url) = maya.create_pay_link(desk, &page, in_days(30)).await.unwrap();
    assert!(url.starts_with(&format!("{}/p/{id}#", server.url)));

    // The server holds ciphertext only.
    let stored: Vec<u8> = sqlx::query_scalar("SELECT sealed FROM pay_links")
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert!(!stored.windows(8).any(|w| w == b"INV-1042" || w == b"FR76 300"));

    // Someone with the link, no account: the page and its content.
    let http = reqwest::Client::new();
    let html = http.get(format!("{}/p/{id}", server.url)).send().await.unwrap();
    assert!(
        html.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("script-src 'self'")
    );
    let public: PublicPayLink = http
        .get(format!("{}/p/{id}/sealed", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (_, key) = anarchy_core::links::parse_url(&url).unwrap();
    assert_eq!(anarchy_core::links::open(&public.sealed, &key).unwrap(), page);
    let claimed = http
        .post(format!("{}/p/{id}/paid", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(claimed.status(), 204);

    let status = &maya.pay_links(desk).await.unwrap()[0];
    assert_eq!(status.views, 1);
    assert!(status.claimed_paid_at_ms.is_some() && !status.revoked);

    // Marking it paid updates the same link, key unchanged.
    let paid = json!({"number": "INV-1042", "status": "paid"});
    maya.update_pay_link(desk, &url, &paid).await.unwrap();
    let public: PublicPayLink = http
        .get(format!("{}/p/{id}/sealed", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(anarchy_core::links::open(&public.sealed, &key).unwrap(), paid);

    // Not a member of the desk: can't list, change or revoke.
    assert!(matches!(
        eve.pay_links(desk).await,
        Err(Error::Api { status: 404, .. })
    ));
    assert!(eve.revoke_pay_link(desk, &id).await.is_err());

    maya.revoke_pay_link(desk, &id).await.unwrap();
    let gone = http
        .get(format!("{}/p/{id}/sealed", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 404);
    let late_claim = http
        .post(format!("{}/p/{id}/paid", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(late_claim.status(), 404);
}
