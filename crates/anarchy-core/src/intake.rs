//! Intake forms: answers from people without an account, readable only by the desk.
//!
//! A form link is meant to be posted anywhere (a website, a QR code), so its
//! `#fragment` key is effectively public and can't protect the answers. Instead
//! each form has a P-256 key pair: the public half goes in the (sealed) form
//! definition, the private half stays in the desk's end-to-end encrypted
//! records. The browser encrypts each submission to the public key (ephemeral
//! ECDH, HKDF-SHA256, AES-256-GCM, all in WebCrypto), so the server, and anyone
//! with the link, stores or sees only ciphertext.
//!
//! Layout of a sealed submission: 65-byte uncompressed ephemeral public key,
//! 12-byte nonce, ciphertext and tag; base64.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

use crate::Error;

/// HKDF `info`; the page uses the same string.
pub const INFO: &[u8] = b"anarchy intake v1";
const POINT: usize = 65;

fn err(msg: &str) -> Error {
    Error::Storage(format!("intake form: {msg}"))
}

fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| err("no randomness"))?;
    Ok(b)
}

fn new_secret() -> Result<SecretKey, Error> {
    // A random 32-byte string is a valid scalar except with negligible odds; retry then.
    for _ in 0..8 {
        if let Ok(k) = SecretKey::from_slice(&random::<32>()?) {
            return Ok(k);
        }
    }
    Err(err("no key"))
}

fn aead_key(secret: &SecretKey, peer: &PublicKey) -> Result<Aes256Gcm, Error> {
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.raw_secret_bytes())
        .expand(INFO, &mut okm)
        .map_err(|_| err("key derivation"))?;
    Ok(Aes256Gcm::new((&okm).into()))
}

/// A fresh key pair: (public, private), both base64. The public key is the
/// uncompressed SEC1 point WebCrypto imports as `raw`.
pub fn new_keys() -> Result<(String, String), Error> {
    let secret = new_secret()?;
    let public = secret.public_key().to_encoded_point(false);
    Ok((
        STANDARD.encode(public.as_bytes()),
        STANDARD.encode(secret.to_bytes()),
    ))
}

/// What the browser does, for tests and for other clients.
pub fn seal_submission(answers: &serde_json::Value, public_b64: &str) -> Result<String, Error> {
    let public = PublicKey::from_sec1_bytes(&STANDARD.decode(public_b64).map_err(|_| err("bad public key"))?)
        .map_err(|_| err("bad public key"))?;
    let eph = new_secret()?;
    let nonce = random::<12>()?;
    let plain = serde_json::to_vec(answers).map_err(|_| err("can't encode"))?;
    let ct = aead_key(&eph, &public)?
        .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
        .map_err(|_| err("encryption failed"))?;
    let mut out = eph.public_key().to_encoded_point(false).as_bytes().to_vec();
    out.extend(nonce);
    out.extend(ct);
    Ok(STANDARD.encode(out))
}

/// Opens a submission with the form's private key.
pub fn open_submission(sealed: &str, private_b64: &str) -> Result<serde_json::Value, Error> {
    let bytes = STANDARD.decode(sealed).map_err(|_| err("not base64"))?;
    if bytes.len() < POINT + 12 + 16 {
        return Err(err("too short"));
    }
    let secret = SecretKey::from_slice(&STANDARD.decode(private_b64).map_err(|_| err("bad private key"))?)
        .map_err(|_| err("bad private key"))?;
    let eph = PublicKey::from_sec1_bytes(&bytes[..POINT]).map_err(|_| err("bad sender key"))?;
    let plain = aead_key(&secret, &eph)?
        .decrypt(Nonce::from_slice(&bytes[POINT..POINT + 12]), &bytes[POINT + 12..])
        .map_err(|_| err("wrong key or changed content"))?;
    serde_json::from_slice(&plain).map_err(|_| err("not JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_private_key_opens_answers() {
        let (public, private) = new_keys().unwrap();
        assert_eq!(STANDARD.decode(&public).unwrap().len(), 65);
        let answers = serde_json::json!({"Name": "Camille Roux", "Email": "camille@example.fr"});
        let sealed = seal_submission(&answers, &public).unwrap();
        assert_eq!(open_submission(&sealed, &private).unwrap(), answers);

        let (_, other) = new_keys().unwrap();
        assert!(open_submission(&sealed, &other).is_err());
        let mut bytes = STANDARD.decode(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(open_submission(&STANDARD.encode(bytes), &private).is_err());
    }
}
