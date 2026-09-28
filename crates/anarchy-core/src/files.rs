//! File encryption for drives.
//!
//! Each file gets its own random key. It's split into 4 MiB chunks, each sealed
//! with XChaCha20-Poly1305 under a nonce made of a per-file random prefix and
//! the chunk index. The additional data binds every chunk to its position and
//! says whether it's the last one, so the server can't reorder, drop or
//! truncate chunks without the download failing. The key travels only inside
//! the drive's MLS channel, as part of the file's record.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Error;

pub const CHUNK: usize = 4 * 1024 * 1024;

/// What a drive record keeps about a file's encryption. Lives inside an
/// end-to-end encrypted message; never sent to the server on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileKey {
    /// 32-byte key, base64.
    pub key: String,
    /// 16-byte nonce prefix, base64.
    pub nonce: String,
    /// SHA-256 of the whole plaintext, hex.
    pub sha256: String,
    pub size: u64,
}

fn aad(index: u64, last: bool) -> [u8; 9] {
    let mut a = [0u8; 9];
    a[..8].copy_from_slice(&index.to_be_bytes());
    a[8] = last as u8;
    a
}

fn nonce(prefix: &[u8], index: u64) -> XNonce {
    let mut n = [0u8; 24];
    n[..16].copy_from_slice(prefix);
    n[16..].copy_from_slice(&index.to_be_bytes());
    *XNonce::from_slice(&n)
}

fn crypto_err(msg: &str) -> Error {
    Error::Storage(msg.to_owned())
}

/// Encrypts `plain` into sealed chunks (always at least one, so empty files work).
pub fn seal(plain: &[u8]) -> Result<(FileKey, Vec<Vec<u8>>), Error> {
    let mut key = [0u8; 32];
    let mut prefix = [0u8; 16];
    getrandom::fill(&mut key).map_err(|_| crypto_err("no randomness"))?;
    getrandom::fill(&mut prefix).map_err(|_| crypto_err("no randomness"))?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let pieces: Vec<&[u8]> = if plain.is_empty() {
        vec![&[][..]]
    } else {
        plain.chunks(CHUNK).collect()
    };
    let count = pieces.len() as u64;
    let mut out = Vec::with_capacity(pieces.len());
    for (i, piece) in pieces.into_iter().enumerate() {
        let i = i as u64;
        let sealed = cipher
            .encrypt(
                &nonce(&prefix, i),
                Payload {
                    msg: piece,
                    aad: &aad(i, i + 1 == count),
                },
            )
            .map_err(|_| crypto_err("encryption failed"))?;
        out.push(sealed);
    }
    let sha = Sha256::digest(plain);
    Ok((
        FileKey {
            key: B64.encode(key),
            nonce: B64.encode(prefix),
            sha256: sha.iter().map(|b| format!("{b:02x}")).collect(),
            size: plain.len() as u64,
        },
        out,
    ))
}

/// Decrypts chunks in order and checks the result against the recorded hash.
pub fn open(fk: &FileKey, chunks: &[Vec<u8>]) -> Result<Vec<u8>, Error> {
    let key: [u8; 32] = B64
        .decode(&fk.key)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| crypto_err("bad file key"))?;
    let prefix = B64.decode(&fk.nonce).map_err(|_| crypto_err("bad file nonce"))?;
    if prefix.len() != 16 {
        return Err(crypto_err("bad file nonce"));
    }
    let cipher = XChaCha20Poly1305::new((&key).into());
    let count = chunks.len() as u64;
    let mut plain = Vec::with_capacity(fk.size as usize);
    for (i, sealed) in chunks.iter().enumerate() {
        let i = i as u64;
        let piece = cipher
            .decrypt(
                &nonce(&prefix, i),
                Payload {
                    msg: sealed,
                    aad: &aad(i, i + 1 == count),
                },
            )
            .map_err(|_| crypto_err("this file was changed or is incomplete"))?;
        plain.extend_from_slice(&piece);
    }
    let sha: String = Sha256::digest(&plain)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if sha != fk.sha256 || plain.len() as u64 != fk.size {
        return Err(crypto_err("this file doesn't match its record"));
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_catches_tampering() {
        let data: Vec<u8> = (0..(CHUNK * 2 + 123)).map(|i| (i % 251) as u8).collect();
        let (fk, chunks) = seal(&data).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(open(&fk, &chunks).unwrap(), data);

        // Reordered, truncated or flipped chunks all fail.
        let swapped = vec![chunks[1].clone(), chunks[0].clone(), chunks[2].clone()];
        assert!(open(&fk, &swapped).is_err());
        assert!(open(&fk, &chunks[..2]).is_err());
        let mut flipped = chunks.clone();
        flipped[2][5] ^= 1;
        assert!(open(&fk, &flipped).is_err());

        let (fk0, c0) = seal(b"").unwrap();
        assert_eq!(open(&fk0, &c0).unwrap(), b"");
    }
}
