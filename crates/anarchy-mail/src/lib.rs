//! Mail on the device (D37).
//!
//! The Inbox mixes a person's email with what happens in the app. Mail is the
//! one thing in Anarchy that isn't end-to-end encrypted: it arrives in the
//! clear from the person's provider. So it stays on their device: this crate
//! talks IMAP (to read) and SMTP (to reply) straight from the desktop app, and
//! the app keeps the account and the messages in its encrypted device database.
//! Nothing about mail goes to the Anarchy server.
//!
//! Messages are shown as plain text: HTML mail is turned into text, remote
//! images never load, and attachments aren't fetched. That loses formatting but
//! closes tracking pixels and the usual HTML attack surface.
//!
//! Sign-in is a password (an app password for Gmail and iCloud). Gmail and
//! Microsoft OAuth need their verification and are not done yet.

use std::sync::Arc;

use async_imap::Session;
use futures_util::TryStreamExt;
use mail_parser::{Address, MessageParser};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::{ClientConfig, RootCertStore, pki_types::ServerName};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("couldn't reach {0}: {1}")]
    Connect(String, String),
    #[error(
        "the mail server refused the sign-in. Check the address and password (Gmail and iCloud need an app password)"
    )]
    Login,
    #[error("mail server error: {0}")]
    Imap(String),
    #[error("couldn't send: {0}")]
    Send(String),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// How to reach the servers. `Plain` is for a server on this computer only (tests, a local bridge).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Security {
    #[default]
    Tls,
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub security: Security,
}

/// Server settings guessed from an address: IMAP host and port, SMTP host and
/// port, and a note on how that provider signs in.
#[derive(Debug, Clone, Serialize)]
pub struct Preset {
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub note: Option<&'static str>,
    pub security: Security,
}

pub fn preset(email: &str) -> Option<Preset> {
    let domain = email.rsplit_once('@')?.1.trim().to_lowercase();
    let p = |imap: &str, smtp: &str, smtp_port: u16, note: Option<&'static str>| Preset {
        imap_host: imap.to_owned(),
        imap_port: 993,
        smtp_host: smtp.to_owned(),
        smtp_port,
        note,
        security: Security::Tls,
    };
    Some(match domain.as_str() {
        "gmail.com" | "googlemail.com" => p(
            "imap.gmail.com",
            "smtp.gmail.com",
            465,
            Some("Gmail needs an app password: Google Account → Security → App passwords."),
        ),
        "icloud.com" | "me.com" | "mac.com" => p(
            "imap.mail.me.com",
            "smtp.mail.me.com",
            587,
            Some("iCloud needs an app-specific password from appleid.apple.com."),
        ),
        "fastmail.com" | "fastmail.fm" => p(
            "imap.fastmail.com",
            "smtp.fastmail.com",
            465,
            Some("Fastmail needs an app password from Settings → Privacy & Security."),
        ),
        "yahoo.com" | "ymail.com" => p(
            "imap.mail.yahoo.com",
            "smtp.mail.yahoo.com",
            465,
            Some("Yahoo needs an app password."),
        ),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => p(
            "outlook.office365.com",
            "smtp.office365.com",
            587,
            Some(
                "Microsoft has turned off password sign-in for most accounts, so this may not work until Microsoft sign-in is added.",
            ),
        ),
        "proton.me" | "protonmail.com" | "pm.me" => Preset {
            imap_host: "127.0.0.1".into(),
            imap_port: 1143,
            smtp_host: "127.0.0.1".into(),
            smtp_port: 1025,
            note: Some(
                "Proton works through Proton Mail Bridge running on this computer; use the password the Bridge shows.",
            ),
            security: Security::Plain,
        },
        _ => p(&format!("imap.{domain}"), &format!("smtp.{domain}"), 465, None),
    })
}

/// One message, as the Inbox shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mail {
    pub uid: u32,
    pub message_id: Option<String>,
    pub from_name: Option<String>,
    pub from_addr: Option<String>,
    pub to: Vec<String>,
    pub subject: String,
    pub date_ms: i64,
    /// Plain text: HTML is turned into text; capped at 64 KB.
    pub text: String,
    pub seen: bool,
    pub references: Vec<String>,
}

/// What a fetch brought back.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Fetched {
    pub mails: Vec<Mail>,
    /// The mailbox's UIDVALIDITY; when it changes, UIDs were renumbered and the cache must be dropped.
    pub uid_validity: Option<u32>,
}

const MAX_TEXT: usize = 64 * 1024;
/// Only the start of a message is fetched: enough for the text, not attachments.
const FETCH_BYTES: u32 = 256 * 1024;

trait Stream: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug> Stream for T {}

fn tls() -> TlsConnector {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

fn local(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

fn plain_refused() -> Error {
    Error::Invalid("unencrypted connections are only allowed to this computer".into())
}

async fn open(account: &Account) -> Result<Session<Box<dyn Stream>>> {
    if account.security == Security::Plain && !local(&account.imap_host) {
        return Err(plain_refused());
    }
    let tcp = TcpStream::connect((account.imap_host.as_str(), account.imap_port))
        .await
        .map_err(|e| Error::Connect(account.imap_host.clone(), e.to_string()))?;
    let stream: Box<dyn Stream> = match account.security {
        Security::Plain => Box::new(tcp),
        Security::Tls => {
            let name = ServerName::try_from(account.imap_host.clone())
                .map_err(|_| Error::Invalid(format!("{} isn't a server name", account.imap_host)))?;
            let s = tls()
                .connect(name, tcp)
                .await
                .map_err(|e| Error::Connect(account.imap_host.clone(), e.to_string()))?;
            Box::new(s)
        }
    };
    let mut client = async_imap::Client::new(stream);
    client
        .read_response()
        .await
        .ok_or_else(|| Error::Imap("the server closed the connection".into()))?
        .map_err(|e| Error::Imap(e.to_string()))?;
    client
        .login(&account.username, &account.password)
        .await
        .map_err(|_| Error::Login)
}

fn imap(e: async_imap::error::Error) -> Error {
    Error::Imap(e.to_string())
}

/// Signs in and opens the inbox, to check the settings work.
pub async fn check(account: &Account) -> Result<()> {
    let mut s = open(account).await?;
    s.select("INBOX").await.map_err(imap)?;
    s.logout().await.map_err(imap)?;
    Ok(())
}

/// The newest messages in the inbox: those after `after_uid`, at most `max`.
pub async fn fetch(account: &Account, after_uid: Option<u32>, max: usize) -> Result<Fetched> {
    let mut s = open(account).await?;
    let mailbox = s.select("INBOX").await.map_err(imap)?;
    let query = match after_uid {
        Some(u) => format!("UID {}:*", u + 1),
        None => "ALL".into(),
    };
    let mut uids: Vec<u32> = s.uid_search(&query).await.map_err(imap)?.into_iter().collect();
    // `UID n:*` always includes the newest message, even when it's older than n.
    uids.retain(|u| after_uid.is_none_or(|a| *u > a));
    uids.sort_unstable();
    let uids: Vec<u32> = uids.into_iter().rev().take(max).collect();
    let mut mails = Vec::with_capacity(uids.len());
    if !uids.is_empty() {
        let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetches: Vec<_> = s
            .uid_fetch(
                &set,
                format!("(UID FLAGS INTERNALDATE BODY.PEEK[]<0.{FETCH_BYTES}>)"),
            )
            .await
            .map_err(imap)?
            .try_collect()
            .await
            .map_err(imap)?;
        for f in fetches {
            let Some(uid) = f.uid else { continue };
            let seen = f.flags().any(|fl| matches!(fl, async_imap::types::Flag::Seen));
            let date = f.internal_date().map(|d| d.timestamp_millis()).unwrap_or(0);
            if let Some(m) = f.body().and_then(|b| parse(uid, b, seen, date)) {
                mails.push(m);
            }
        }
    }
    s.logout().await.map_err(imap)?;
    mails.sort_by_key(|m| std::cmp::Reverse(m.date_ms));
    Ok(Fetched {
        mails,
        uid_validity: mailbox.uid_validity,
    })
}

fn first_addr(a: Option<&Address<'_>>) -> (Option<String>, Option<String>) {
    let Some(a) = a.and_then(|a| a.first()) else {
        return (None, None);
    };
    (a.name().map(str::to_owned), a.address().map(str::to_owned))
}

/// Turns raw message bytes into what the Inbox shows.
pub fn parse(uid: u32, raw: &[u8], seen: bool, fallback_date_ms: i64) -> Option<Mail> {
    let msg = MessageParser::default().parse(raw)?;
    let (from_name, from_addr) = first_addr(msg.from());
    let to = msg
        .to()
        .map(|a| a.iter().filter_map(|x| x.address().map(str::to_owned)).collect())
        .unwrap_or_default();
    let mut text = msg.body_text(0).map(|t| t.into_owned()).unwrap_or_default();
    if text.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n…");
    }
    let date_ms = msg
        .date()
        .map(|d| d.to_timestamp() * 1000)
        .unwrap_or(fallback_date_ms);
    let mut references: Vec<String> = msg
        .references()
        .as_text_list()
        .map(|l| l.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default();
    if let Some(r) = msg.in_reply_to().as_text()
        && !references.iter().any(|x| x == r)
    {
        references.push(r.to_owned());
    }
    Some(Mail {
        uid,
        message_id: msg.message_id().map(str::to_owned),
        from_name,
        from_addr,
        to,
        subject: msg.subject().unwrap_or("(no subject)").to_owned(),
        date_ms,
        text: text.trim().to_owned(),
        seen,
        references,
    })
}

/// Marks a message read (or unread) on the server.
pub async fn set_seen(account: &Account, uid: u32, seen: bool) -> Result<()> {
    let mut s = open(account).await?;
    s.select("INBOX").await.map_err(imap)?;
    let flag = if seen {
        "+FLAGS (\\Seen)"
    } else {
        "-FLAGS (\\Seen)"
    };
    let _: Vec<_> = s
        .uid_store(uid.to_string(), flag)
        .await
        .map_err(imap)?
        .try_collect()
        .await
        .map_err(imap)?;
    s.logout().await.map_err(imap)?;
    Ok(())
}

/// A message to send. A reply carries what it answers, so it threads in the other person's mail.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Outgoing {
    pub to: String,
    pub subject: String,
    pub text: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
}

/// Sends plain-text mail through the account's SMTP server.
pub async fn send(account: &Account, out: &Outgoing) -> Result<()> {
    use lettre::message::{Mailbox, header::ContentType};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
    type Smtp = AsyncSmtpTransport<Tokio1Executor>;
    let bad = |e: String| Error::Send(e);
    let from: Mailbox = match &account.name {
        Some(n) => format!("{n} <{}>", account.email),
        None => account.email.clone(),
    }
    .parse()
    .map_err(|e: lettre::address::AddressError| bad(e.to_string()))?;
    let to: Mailbox = out
        .to
        .parse()
        .map_err(|e: lettre::address::AddressError| bad(format!("{}: {e}", out.to)))?;
    let mut b = Message::builder()
        .from(from)
        .to(to)
        .subject(&out.subject)
        .header(ContentType::TEXT_PLAIN);
    let angle = |r: &str| format!("<{}>", r.trim_matches(['<', '>']));
    if let Some(r) = &out.in_reply_to {
        b = b.in_reply_to(angle(r));
    }
    if !out.references.is_empty() {
        b = b.references(
            out.references
                .iter()
                .map(|r| angle(r))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    let msg = b.body(out.text.clone()).map_err(|e| bad(e.to_string()))?;
    let creds = Credentials::new(account.username.clone(), account.password.clone());
    let transport = match account.security {
        Security::Plain if local(&account.smtp_host) => Smtp::builder_dangerous(&account.smtp_host)
            .port(account.smtp_port)
            .credentials(creds)
            .build(),
        Security::Plain => return Err(plain_refused()),
        Security::Tls if account.smtp_port == 587 => Smtp::starttls_relay(&account.smtp_host)
            .map_err(|e| bad(e.to_string()))?
            .port(587)
            .credentials(creds)
            .build(),
        Security::Tls => Smtp::relay(&account.smtp_host)
            .map_err(|e| bad(e.to_string()))?
            .port(account.smtp_port)
            .credentials(creds)
            .build(),
    };
    transport.send(msg).await.map_err(|e| bad(e.to_string()))?;
    Ok(())
}
