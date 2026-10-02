//! Against a real IMAP server: run `scripts/test-mail-server.sh` and set
//! `ANARCHY_TEST_IMAP=127.0.0.1:1143`. Without it these tests say so and pass.

use anarchy_mail::{Account, Outgoing, Security, check, fetch, send, set_seen};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

fn server() -> Option<(String, u16)> {
    let v = std::env::var("ANARCHY_TEST_IMAP").ok()?;
    let (h, p) = v.rsplit_once(':')?;
    Some((h.to_owned(), p.parse().ok()?))
}

fn account(host: &str, port: u16, smtp_port: u16, password: &str) -> Account {
    Account {
        email: "maya@example.com".into(),
        name: Some("Maya Chen".into()),
        imap_host: host.into(),
        imap_port: port,
        smtp_host: "127.0.0.1".into(),
        smtp_port,
        username: "maya".into(),
        password: password.into(),
        security: Security::Plain,
    }
}

async fn put(host: &str, port: u16, raw: &str, seen: bool) {
    let tcp = tokio::net::TcpStream::connect((host, port)).await.unwrap();
    let mut c = async_imap::Client::new(tcp);
    c.read_response().await.unwrap().unwrap();
    let mut s = c.login("maya", "secret").await.map_err(|e| e.0).unwrap();
    s.append(
        "INBOX",
        seen.then_some("(\\Seen)"),
        None,
        raw.replace('\n', "\r\n"),
    )
    .await
    .unwrap();
    s.logout().await.unwrap();
}

#[tokio::test]
async fn reads_mail_as_plain_text_marks_it_read_and_replies() {
    let Some((host, port)) = server() else {
        eprintln!("skipped: set ANARCHY_TEST_IMAP (see scripts/test-mail-server.sh)");
        return;
    };
    // A fresh subject per run: the server keeps mail between runs.
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let acc = account(&host, port, 0, "secret");
    check(&acc).await.unwrap();
    assert!(matches!(
        check(&account(&host, port, 0, "wrong")).await,
        Err(anarchy_mail::Error::Login)
    ));
    // Unencrypted is only ever allowed to this computer.
    let mut far = acc.clone();
    far.imap_host = "imap.example.com".into();
    assert!(matches!(check(&far).await, Err(anarchy_mail::Error::Invalid(_))));

    let before = fetch(&acc, None, 500)
        .await
        .unwrap()
        .mails
        .iter()
        .map(|m| m.uid)
        .max();
    put(&host, port, &format!("From: Jonas Weber <jonas@urbanthreads.eu>\nTo: maya@example.com\nSubject: Invoice {tag}\nMessage-ID: <inv-{tag}@urbanthreads.eu>\nDate: Thu, 01 Oct 2026 09:30:00 +0200\nContent-Type: text/plain; charset=utf-8\n\nHi Maya, we'll pay invoice 1042 on the 15th.\n"), false).await;
    put(&host, port, &format!("From: Acme <news@acme.test>\nTo: maya@example.com\nSubject: News {tag}\nDate: Thu, 01 Oct 2026 10:00:00 +0200\nContent-Type: text/html; charset=utf-8\n\n<html><body><p>Hello <b>there</b></p><img src=\"https://track.acme.test/p.gif\"><script>alert(1)</script></body></html>\n"), true).await;

    let got = fetch(&acc, before, 50).await.unwrap();
    assert!(got.uid_validity.is_some());
    assert_eq!(got.mails.len(), 2, "only what's new since the last fetch");
    let inv = got
        .mails
        .iter()
        .find(|m| m.subject == format!("Invoice {tag}"))
        .unwrap();
    assert_eq!(inv.from_name.as_deref(), Some("Jonas Weber"));
    assert_eq!(inv.from_addr.as_deref(), Some("jonas@urbanthreads.eu"));
    assert!(inv.text.contains("invoice 1042 on the 15th"));
    assert!(!inv.seen);
    let news = got
        .mails
        .iter()
        .find(|m| m.subject == format!("News {tag}"))
        .unwrap();
    assert!(news.seen);
    assert!(
        news.text.contains("Hello there"),
        "HTML is shown as text: {:?}",
        news.text
    );
    assert!(
        !news.text.contains('<') && !news.text.contains("track.acme"),
        "no markup, no remote images: {:?}",
        news.text
    );

    set_seen(&acc, inv.uid, true).await.unwrap();
    let again = fetch(&acc, before, 50).await.unwrap();
    assert!(again.mails.iter().find(|m| m.uid == inv.uid).unwrap().seen);
    let newest = again.mails.iter().map(|m| m.uid).max();
    assert!(
        fetch(&acc, newest, 50).await.unwrap().mails.is_empty(),
        "nothing new after the newest"
    );

    // A reply goes out over SMTP and threads with what it answers.
    let smtp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let smtp_port = smtp.local_addr().unwrap().port();
    let received = tokio::spawn(async move {
        let (sock, _) = smtp.accept().await.unwrap();
        let (r, mut w) = sock.into_split();
        let mut r = BufReader::new(r);
        w.write_all(b"220 test ESMTP\r\n").await.unwrap();
        let (mut data, mut in_data, mut line) = (String::new(), false, String::new());
        loop {
            line.clear();
            if r.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if in_data {
                if line == ".\r\n" {
                    in_data = false;
                    w.write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                }
                continue;
            }
            let cmd = line.to_uppercase();
            let reply: &[u8] = if cmd.starts_with("EHLO") {
                b"250-test\r\n250 AUTH PLAIN LOGIN\r\n"
            } else if cmd.starts_with("AUTH") {
                b"235 ok\r\n"
            } else if cmd.starts_with("DATA") {
                in_data = true;
                b"354 go\r\n"
            } else if cmd.starts_with("QUIT") {
                w.write_all(b"221 bye\r\n").await.unwrap();
                break;
            } else {
                b"250 ok\r\n"
            };
            w.write_all(reply).await.unwrap();
        }
        data
    });
    let out = Outgoing {
        to: "jonas@urbanthreads.eu".into(),
        subject: format!("Re: Invoice {tag}"),
        text: "Thanks Jonas, noted.".into(),
        in_reply_to: inv.message_id.clone(),
        references: vec![inv.message_id.clone().unwrap()],
    };
    send(&account(&host, port, smtp_port, "secret"), &out)
        .await
        .unwrap();
    let data = received.await.unwrap();
    assert!(
        data.contains(&format!("In-Reply-To: <inv-{tag}@urbanthreads.eu>")),
        "{data}"
    );
    assert!(data.contains("Thanks Jonas, noted."));
    assert!(
        data.contains("From: \"Maya Chen\" <maya@example.com>")
            || data.contains("From: Maya Chen <maya@example.com>"),
        "{data}"
    );
}

#[test]
fn presets_know_the_big_providers() {
    let g = anarchy_mail::preset("someone@gmail.com").unwrap();
    assert_eq!(
        (
            g.imap_host.as_str(),
            g.imap_port,
            g.smtp_host.as_str(),
            g.smtp_port
        ),
        ("imap.gmail.com", 993, "smtp.gmail.com", 465)
    );
    assert!(g.note.unwrap().contains("app password"));
    let other = anarchy_mail::preset("ops@northwind.org").unwrap();
    assert_eq!(other.imap_host, "imap.northwind.org");
    assert!(anarchy_mail::preset("not an address").is_none());
}
