//! Intake forms: a public form whose answers only the desk can read.

use anarchy_core::{Client, Device, Error, intake};
use anarchy_proto::{FormSubmission, PublicPayLink, SpaceKind, SubmitForm};
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
async fn answers_are_sealed_to_the_desk_and_deleted_once_imported() {
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

    let (public_key, private_key) = intake::new_keys().unwrap();
    let form = json!({"from": "Studio Chen", "title": "New project", "public_key": public_key,
        "fields": [{"id": "name", "label": "Name", "type": "text", "required": true}]});
    let (id, url) = maya.create_form(desk, &form, in_days(90)).await.unwrap();
    assert!(url.starts_with(&format!("{}/f/{id}#", server.url)));

    // Someone with the link reads the form and answers it, as the page does.
    let http = reqwest::Client::new();
    let public: PublicPayLink = http
        .get(format!("{}/f/{id}/sealed", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (_, key) = anarchy_core::links::parse_url_at(&url, "/f/").unwrap();
    let opened = anarchy_core::links::open(&public.sealed, &key).unwrap();
    assert_eq!(opened, form);
    let answers = json!({"answers": {"name": "Camille Roux, Trendy Terra"}});
    let sealed = intake::seal_submission(&answers, opened["public_key"].as_str().unwrap()).unwrap();
    let sent = http
        .post(format!("{}/f/{id}/submit", server.url))
        .json(&SubmitForm { sealed })
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 204);
    let junk = http
        .post(format!("{}/f/{id}/submit", server.url))
        .json(&SubmitForm {
            sealed: "c2hvcnQ=".into(),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(junk.status(), 400);

    // The server can't read the answer; the fragment key can't either.
    let stored: Vec<u8> = sqlx::query_scalar("SELECT sealed FROM intake_submissions")
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert!(!stored.windows(6).any(|w| w == b"Camill"));

    let waiting: Vec<FormSubmission> = maya.form_submissions(desk, &id).await.unwrap();
    assert_eq!(waiting.len(), 1);
    assert_eq!(
        intake::open_submission(&waiting[0].sealed, &private_key).unwrap(),
        answers
    );

    // Outsiders can't list or delete answers.
    assert!(matches!(
        eve.form_submissions(desk, &id).await,
        Err(Error::Api { status: 404, .. })
    ));
    assert!(
        eve.delete_form_submission(desk, &id, waiting[0].id)
            .await
            .is_err()
    );

    // Imported: deleted from the server (twice is harmless).
    maya.delete_form_submission(desk, &id, waiting[0].id)
        .await
        .unwrap();
    maya.delete_form_submission(desk, &id, waiting[0].id)
        .await
        .unwrap();
    assert!(maya.form_submissions(desk, &id).await.unwrap().is_empty());

    // Withdrawn: the page and submitting both end.
    maya.revoke_form(desk, &id).await.unwrap();
    let gone = http
        .get(format!("{}/f/{id}/sealed", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 404);
    let late = http
        .post(format!("{}/f/{id}/submit", server.url))
        .json(&SubmitForm {
            sealed: intake::seal_submission(&answers, &public_key).unwrap(),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(late.status(), 404);
}

/// The real page in a real browser: WebCrypto's ECDH, HKDF and AES-GCM must
/// produce what the Rust side opens. Opt-in, as it needs Node and Playwright:
/// `ANARCHY_BROWSER_TEST=1 NODE_PATH=$(npm root -g) cargo test --test intake_forms`.
#[tokio::test]
async fn the_browser_page_seals_answers_the_desk_can_open() {
    if std::env::var("ANARCHY_BROWSER_TEST").is_err() {
        return;
    }
    let server = TestServer::start_with(TestOptions {
        open: true,
        ..TestOptions::default()
    })
    .await;
    let mut maya = email_user(&server, "maya@example.com").await;
    let space = maya.create_space("Studio", SpaceKind::Freelance).await.unwrap();
    let desk = maya
        .create_desk(Some(space.id), "Collections", "collections")
        .await
        .unwrap();
    let (public_key, private_key) = intake::new_keys().unwrap();
    let form = json!({"from": "Studio Chen", "title": "New project", "public_key": public_key, "fields": [
        {"id": "name", "label": "Name", "type": "text", "required": true},
        {"id": "email", "label": "Email", "type": "email", "required": true}]});
    let (id, url) = maya.create_form(desk, &form, in_days(30)).await.unwrap();

    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fill_form.mjs");
    let url2 = url.clone();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node").arg(script).arg(url2).output()
    })
    .await
    .unwrap()
    .expect("node");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let got = maya.form_submissions(desk, &id).await.unwrap();
    assert_eq!(got.len(), 1);
    let opened = intake::open_submission(&got[0].sealed, &private_key).unwrap();
    assert_eq!(opened["answers"]["name"], "Camille Roux");
    assert_eq!(opened["answers"]["email"], "camille@example.fr");
    assert_eq!(opened["labels"]["name"], "Name");
}
