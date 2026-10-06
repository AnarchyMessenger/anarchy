//! Sign-in and request authentication.
//!
//! Users sign in with their organisation's OpenID Connect provider (Keycloak,
//! Authentik, Zitadel, Entra ID, …). The client sends the ID token here; we
//! verify it against the provider's published keys, then issue our own session
//! token. Only a SHA-256 hash of that token is stored.
//!
//! Signing in proves who a user is. It never gives access to message content:
//! that needs the keys on the user's devices (ARCHITECTURE §3).

use std::time::{Duration, Instant};

use anarchy_proto::{DEVICE_HEADER, DeviceId, OrgId, UserId};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{ApiError, AppState};

/// Asymmetric algorithms only: `none` and shared-secret HMAC tokens are refused.
const ALLOWED_ALGS: [Algorithm; 5] = [
    Algorithm::RS256,
    Algorithm::PS256,
    Algorithm::ES256,
    Algorithm::ES384,
    Algorithm::EdDSA,
];
const JWKS_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct OidcConfig {
    /// Must match the token's `iss` exactly.
    pub issuer: String,
    /// The client ID the org registered for Anarchy; must appear in the token's `aud`.
    pub audience: String,
    /// Where to fetch signing keys. When `None`, discovered from
    /// `{issuer}/.well-known/openid-configuration`.
    pub jwks_url: Option<String>,
}

pub struct Oidc {
    config: OidcConfig,
    http: reqwest::Client,
    jwks: RwLock<Option<(Instant, JwkSet)>>,
}

#[derive(Debug, Deserialize)]
pub struct IdClaims {
    pub sub: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

impl Oidc {
    pub fn new(config: OidcConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
            jwks: RwLock::new(None),
        }
    }

    pub fn issuer(&self) -> &str {
        &self.config.issuer
    }

    pub fn audience(&self) -> &str {
        &self.config.audience
    }

    /// Verifies signature, issuer, audience and expiry.
    pub async fn verify(&self, id_token: &str) -> Result<IdClaims, ApiError> {
        let header = jsonwebtoken::decode_header(id_token).map_err(|_| ApiError::unauthorized())?;
        if !ALLOWED_ALGS.contains(&header.alg) {
            return Err(ApiError::unauthorized());
        }
        let kid = header.kid.ok_or_else(ApiError::unauthorized)?;
        let key = self.key(&kid).await?;

        let mut validation = Validation::new(header.alg);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.audience]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        jsonwebtoken::decode::<IdClaims>(id_token, &key, &validation)
            .map(|data| data.claims)
            .map_err(|e| {
                tracing::debug!("rejected ID token: {e}");
                ApiError::unauthorized()
            })
    }

    /// Finds the key for `kid`, refetching the key set once if it's unknown (key rotation).
    async fn key(&self, kid: &str) -> Result<DecodingKey, ApiError> {
        if let Some((fetched, set)) = &*self.jwks.read().await
            && fetched.elapsed() < JWKS_TTL
            && let Some(jwk) = set.find(kid)
        {
            return DecodingKey::from_jwk(jwk).map_err(|_| ApiError::unauthorized());
        }
        let set = self.fetch_jwks().await?;
        let key = set.find(kid).map(DecodingKey::from_jwk);
        *self.jwks.write().await = Some((Instant::now(), set));
        match key {
            Some(Ok(k)) => Ok(k),
            _ => Err(ApiError::unauthorized()),
        }
    }

    async fn fetch_jwks(&self) -> Result<JwkSet, ApiError> {
        let url = match &self.config.jwks_url {
            Some(url) => url.clone(),
            None => {
                #[derive(Deserialize)]
                struct Discovery {
                    jwks_uri: String,
                }
                let discovery = format!(
                    "{}/.well-known/openid-configuration",
                    self.config.issuer.trim_end_matches('/')
                );
                let d: Discovery = self.get_json(&discovery).await?;
                d.jwks_uri
            }
        };
        self.get_json(&url).await
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, ApiError> {
        let fail = |e: reqwest::Error| {
            tracing::error!("identity provider unreachable at {url}: {e}");
            ApiError::unavailable("identity provider unreachable")
        };
        self.http
            .get(url)
            .send()
            .await
            .map_err(fail)?
            .error_for_status()
            .map_err(fail)?
            .json()
            .await
            .map_err(fail)
    }
}

/// A new random invite code (128 bits, base32, grouped for reading aloud) and the hash to store.
pub fn new_invite_code() -> (String, Vec<u8>) {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
    let mut bits = 0u32;
    let mut nbits = 0;
    let mut raw = String::new();
    for b in bytes {
        bits = (bits << 8) | b as u32;
        nbits += 8;
        while nbits >= 5 {
            nbits -= 5;
            raw.push(ALPHABET[((bits >> nbits) & 31) as usize] as char);
        }
    }
    if nbits > 0 {
        raw.push(ALPHABET[((bits << (5 - nbits)) & 31) as usize] as char);
    }
    let hash = hash_token(&raw);
    let grouped = raw
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-");
    (grouped, hash)
}

pub fn hash_invite_code(typed: &str) -> Vec<u8> {
    hash_token(&anarchy_proto::normalize_invite_code(typed))
}

/// A new random session token and the hash to store.
pub fn new_session_token() -> (String, Vec<u8>) {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = hash_token(&token);
    (token, hash)
}

pub(crate) fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// A request from a signed-in user (any device, or none yet).
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub user_id: UserId,
    pub org_id: OrgId,
    pub is_guest: bool,
}

/// A request from a registered, non-revoked device of the signed-in user.
#[derive(Debug, Clone, Copy)]
pub struct AuthDevice {
    pub user_id: UserId,
    pub org_id: OrgId,
    pub device_id: DeviceId,
}

async fn session_user(parts: &Parts, db: &PgPool) -> Result<AuthUser, ApiError> {
    let token = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    // An expired guest is signed out everywhere, whatever their session says.
    let row: Option<(Uuid, Uuid, bool)> = sqlx::query_as(
        "SELECT u.id, u.org_id, u.is_guest FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()
           AND (u.expires_at IS NULL OR u.expires_at > now())",
    )
    .bind(hash_token(token))
    .fetch_optional(db)
    .await?;
    let (user_id, org_id, is_guest) = row.ok_or_else(ApiError::unauthorized)?;
    Ok(AuthUser {
        user_id,
        org_id,
        is_guest,
    })
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        session_user(parts, &state.db).await
    }
}

impl FromRequestParts<AppState> for AuthDevice {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let user = session_user(parts, &state.db).await?;
        let device_id: DeviceId = parts
            .headers
            .get(DEVICE_HEADER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| ApiError::bad_request("missing or invalid device header"))?;
        let owned: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
                .bind(device_id)
                .bind(user.user_id)
                .fetch_optional(&state.db)
                .await?;
        if owned.is_none() {
            return Err(ApiError::forbidden("device is not registered to this user"));
        }
        Ok(AuthDevice {
            user_id: user.user_id,
            org_id: user.org_id,
            device_id,
        })
    }
}
