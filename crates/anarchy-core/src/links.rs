//! Sealing pay-link pages. AES-256-GCM because the page decrypts in a browser
//! with WebCrypto, which has no XChaCha20. Layout: 12-byte random nonce, then
//! the ciphertext and tag. The key is 32 random bytes, base64url in the link's
//! fragment.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

use crate::Error;

fn err(msg: &str) -> Error {
    Error::Storage(format!("pay link: {msg}"))
}

/// Seals with a fresh key; returns (base64 sealed, base64url key).
pub fn seal(page: &serde_json::Value) -> Result<(String, String), Error> {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|_| err("no randomness"))?;
    Ok((seal_with(page, &key)?, URL_SAFE_NO_PAD.encode(key)))
}

pub fn seal_with(page: &serde_json::Value, key: &[u8; 32]) -> Result<String, Error> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|_| err("no randomness"))?;
    let plain = serde_json::to_vec(page).map_err(|_| err("can't encode"))?;
    let sealed = Aes256Gcm::new(key.into())
        .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
        .map_err(|_| err("encryption failed"))?;
    let mut out = nonce.to_vec();
    out.extend(sealed);
    Ok(STANDARD.encode(out))
}

pub fn open(sealed: &str, key: &[u8; 32]) -> Result<serde_json::Value, Error> {
    let bytes = STANDARD.decode(sealed).map_err(|_| err("not base64"))?;
    if bytes.len() < 28 {
        return Err(err("too short"));
    }
    let plain = Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
        .map_err(|_| err("wrong key or changed content"))?;
    serde_json::from_slice(&plain).map_err(|_| err("not JSON"))
}

/// The link id and key from a link made by [`crate::Client::create_pay_link`].
pub fn parse_url(url: &str) -> Result<(String, [u8; 32]), Error> {
    let (path, fragment) = url.split_once('#').ok_or_else(|| err("no key in the link"))?;
    let id = path
        .rsplit_once("/p/")
        .map(|(_, id)| id.to_owned())
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .ok_or_else(|| err("not a pay link"))?;
    let key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(fragment)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| err("bad key"))?;
    Ok((id, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let page = serde_json::json!({"number": "INV-1001", "amount": 120000});
        let (sealed, key) = seal(&page).unwrap();
        let (id, k) = parse_url(&format!("https://x.example/p/abc#{key}")).unwrap();
        assert_eq!(id, "abc");
        assert_eq!(open(&sealed, &k).unwrap(), page);
        let mut bytes = STANDARD.decode(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(open(&STANDARD.encode(bytes), &k).is_err());
        assert!(open(&sealed, &[0u8; 32]).is_err());
    }
}
