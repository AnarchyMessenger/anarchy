//! Signing in from a native app: OpenID Connect authorization code flow with
//! PKCE and a loopback redirect (RFC 8252).
//!
//! 1. [`begin`] discovers the provider's endpoints, opens a listener on
//!    `127.0.0.1` and builds the URL to open in the system browser.
//! 2. The user signs in with their organisation, in the browser they already
//!    trust; the app never sees their password.
//! 3. [`PendingSignIn::finish`] receives the redirect, checks `state`, and trades
//!    the code (plus the PKCE verifier) for an ID token.

use std::time::Duration;

use anarchy_proto::AuthConfig;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::Error;

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
}

/// A sign-in waiting for the browser to come back.
pub struct PendingSignIn {
    /// Open this in the system browser.
    pub url: String,
    listener: TcpListener,
    redirect_uri: String,
    verifier: String,
    state: String,
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    http: reqwest::Client,
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random number generator unavailable");
    URL_SAFE_NO_PAD.encode(buf)
}

fn oidc_error(msg: impl Into<String>) -> Error {
    Error::SignIn(msg.into())
}

/// Fetches a workspace's sign-in settings (`GET /v1/auth/config`).
/// Webmail and other shared domains: nobody's organisation, so no lookup.
const SHARED_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "yahoo.fr",
    "icloud.com",
    "me.com",
    "mac.com",
    "proton.me",
    "protonmail.com",
    "gmx.com",
    "gmx.de",
    "gmx.fr",
    "web.de",
    "orange.fr",
    "free.fr",
    "laposte.net",
    "sfr.fr",
    "wanadoo.fr",
    "aol.com",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "fastmail.com",
    "tutanota.com",
];

/// The server an organisation runs for its email domain, if it publishes one at
/// `https://<domain>/.well-known/anarchy.json` as `{"server": "https://…"}`.
/// Lets someone type their work email and land on their company's server
/// without knowing its address. The lookup goes to the email's own domain only.
pub async fn discover_server(email: &str) -> Option<String> {
    let domain = email.rsplit_once('@')?.1.trim().to_ascii_lowercase();
    if domain.is_empty()
        || !domain.contains('.')
        || SHARED_DOMAINS.contains(&domain.as_str())
        || !domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    #[derive(Deserialize)]
    struct WellKnown {
        server: String,
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::limited(2))
        .build()
        .ok()?;
    let resp = http
        .get(format!("https://{domain}/.well-known/anarchy.json"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let found: WellKnown = resp.json().await.ok()?;
    found.server.starts_with("https://").then_some(found.server)
}

pub async fn workspace_config(server_url: &str) -> Result<AuthConfig, Error> {
    let url = format!("{}/v1/auth/config", server_url.trim_end_matches('/'));
    let resp = reqwest::get(&url).await?;
    if !resp.status().is_success() {
        return Err(oidc_error(format!(
            "{server_url} doesn't look like an Anarchy server ({})",
            resp.status()
        )));
    }
    resp.json()
        .await
        .map_err(|_| oidc_error(format!("{server_url} doesn't look like an Anarchy server")))
}

/// Starts a sign-in against the workspace's identity provider.
pub async fn begin(config: &AuthConfig) -> Result<PendingSignIn, Error> {
    let (Some(issuer), Some(client_id)) = (&config.issuer, &config.client_id) else {
        return Err(oidc_error(format!(
            "{} doesn't sign in with an identity provider",
            config.org_name
        )));
    };
    let http = reqwest::Client::new();
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    let discovery: Discovery = http
        .get(&discovery_url)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| oidc_error(format!("identity provider unreachable: {e}")))?
        .json()
        .await?;

    // Loopback redirect on a port the OS picks (RFC 8252 §7.3).
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| oidc_error(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| oidc_error(e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let verifier = random_url_safe(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_url_safe(16);

    let mut url = reqwest::Url::parse(&discovery.authorization_endpoint)
        .map_err(|e| oidc_error(format!("bad authorization endpoint: {e}")))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", "openid profile email")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");

    Ok(PendingSignIn {
        url: url.into(),
        listener,
        redirect_uri,
        verifier,
        state,
        token_endpoint: discovery.token_endpoint,
        client_id: client_id.clone(),
        client_secret: config.client_secret.clone(),
        http,
    })
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Anarchy</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;color:#11151c\">\
<p>You're signed in. You can close this tab and go back to Anarchy.</p>";
const FAIL_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Anarchy</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;color:#b3261e\">\
<p>Sign-in didn't complete. Go back to Anarchy and try again.</p>";

impl PendingSignIn {
    /// Waits for the browser redirect and returns the ID token.
    pub async fn finish(self, timeout: Duration) -> Result<String, Error> {
        let (code, returned_state) = tokio::time::timeout(timeout, self.receive_redirect())
            .await
            .map_err(|_| oidc_error("sign-in timed out; try again"))??;
        if returned_state != self.state {
            // Someone else's redirect, or a replay: never trade this code.
            return Err(oidc_error("sign-in response didn't match this request"));
        }

        #[derive(Deserialize)]
        struct TokenResponse {
            id_token: Option<String>,
        }
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("client_id", self.client_id.as_str()),
            ("code_verifier", self.verifier.as_str()),
        ];
        // Google's installed-app clients require their (public) secret too.
        if let Some(secret) = &self.client_secret {
            form.push(("client_secret", secret.as_str()));
        }
        let resp = self.http.post(&self.token_endpoint).form(&form).send().await?;
        if !resp.status().is_success() {
            return Err(oidc_error(format!(
                "identity provider refused the sign-in ({})",
                resp.status()
            )));
        }
        let token: TokenResponse = resp.json().await?;
        token
            .id_token
            .ok_or_else(|| oidc_error("identity provider returned no ID token"))
    }

    /// Accepts connections until one is the `/callback` redirect.
    async fn receive_redirect(&self) -> Result<(String, String), Error> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|e| oidc_error(e.to_string()))?;
            let mut buf = vec![0u8; 8192];
            let mut len = 0;
            while len < buf.len() {
                let n = stream
                    .read(&mut buf[len..])
                    .await
                    .map_err(|e| oidc_error(e.to_string()))?;
                len += n;
                if n == 0 || buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buf[..len]);
            let target = request
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("");
            let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else {
                continue;
            };
            if url.path() != "/callback" {
                // Browsers also ask for /favicon.ico and the like.
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                    .await;
                continue;
            }
            let param = |k: &str| {
                url.query_pairs()
                    .find(|(key, _)| key == k)
                    .map(|(_, v)| v.into_owned())
            };
            let result = match (param("code"), param("state"), param("error")) {
                (Some(code), Some(state), None) => Ok((code, state)),
                (_, _, Some(err)) => Err(oidc_error(format!("identity provider said: {err}"))),
                _ => Err(oidc_error("sign-in response was missing its code")),
            };
            let page = if result.is_ok() { DONE_PAGE } else { FAIL_PAGE };
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                page.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
            return result;
        }
    }
}
