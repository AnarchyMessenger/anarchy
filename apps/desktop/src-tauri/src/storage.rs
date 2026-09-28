//! Where the device lives: an encrypted SQLCipher file in the app's data folder.
//! Its 32-byte key is kept one of two ways, and never on disk in the clear:
//!
//! - **Passphrase:** `device.key` holds the key encrypted with a key derived
//!   from the person's passphrase (Argon2id, then XChaCha20-Poly1305). The app
//!   opens locked and asks for it. Works without any keychain.
//! - **Keychain:** macOS Keychain, Windows Credential Manager or Secret Service.
//!
//! With neither, the device is temporary: its file is deleted at the next start
//! unless a passphrase is set before quitting.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use anarchy_core::Device;
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "org.anarchymessenger.desktop";
const KEYCHAIN_ACCOUNT: &str = "device-database-key";
/// A keychain that hasn't answered by now isn't going to (a locked or missing
/// Secret Service can hang for many seconds). Better a clear message than a frozen app.
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);
/// Passphrases shorter than this are refused.
pub const MIN_PASSPHRASE: usize = 8;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Storage {
    /// Encrypted on disk. `lock` is `keychain` or `passphrase`.
    Saved { path: String, lock: String },
    /// Encrypted on disk with a key only in memory; gone at the next start unless
    /// a passphrase is set. `reason` says why there's no keychain.
    Temporary { reason: String },
    /// Waiting for the passphrase.
    Locked,
}

/// What opening found. Made once at startup: variant size doesn't matter.
#[allow(clippy::large_enum_variant)]
pub enum Opened {
    Ready(Device, Storage, [u8; 32]),
    Locked,
}

fn paths(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        dir.join("device.db"),
        dir.join("device.key"),
        dir.join("device.temporary"),
    )
}

/// Opens the device, or reports that it's locked, or falls back to a temporary one.
pub fn open_device(dir: &Path) -> Opened {
    if let Err(e) = std::fs::create_dir_all(dir) {
        return temporary(dir, format!("can't create {}: {e}", dir.display()));
    }
    let (db, wrapped, marker) = paths(dir);
    if wrapped.exists() {
        return Opened::Locked;
    }
    if marker.exists() {
        // Left over from a temporary device that was never saved.
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_file(&marker);
    }
    match open_with_keychain(&db) {
        Ok((device, key)) => {
            let storage = Storage::Saved {
                path: db.display().to_string(),
                lock: "keychain".into(),
            };
            Opened::Ready(device, storage, key)
        }
        Err(reason) => temporary(dir, reason),
    }
}

/// A device in a file whose key lives only in memory, so a passphrase can still
/// save it later. If even that fails, an in-memory device.
fn temporary(dir: &Path, reason: String) -> Opened {
    eprintln!("anarchy: running with a temporary device: {reason}");
    let (db, _, marker) = paths(dir);
    let key = random_key();
    let device = std::fs::write(&marker, b"")
        .ok()
        .and_then(|_| Device::create(&db, &key).ok())
        .unwrap_or_else(|| Device::new().expect("can't create even an in-memory device"));
    Opened::Ready(device, Storage::Temporary { reason }, key)
}

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("OS random number generator unavailable");
    key
}

/// Opens a locked device. Wrong passphrases get one plain message.
pub fn unlock(dir: &Path, passphrase: &str) -> Result<(Device, Storage, [u8; 32]), String> {
    let (db, wrapped, _) = paths(dir);
    let file: Wrapped = serde_json::from_slice(&std::fs::read(&wrapped).map_err(|e| e.to_string())?)
        .map_err(|_| "device.key is damaged")?;
    let key = file.open(passphrase)?;
    let device = Device::open(&db, &key).map_err(|e| e.to_string())?;
    Ok((
        device,
        Storage::Saved {
            path: db.display().to_string(),
            lock: "passphrase".into(),
        },
        key,
    ))
}

/// Protects the device with a passphrase from now on: writes `device.key`, and
/// removes the keychain copy (otherwise the passphrase would protect nothing).
pub fn set_passphrase(dir: &Path, key: &[u8; 32], passphrase: &str) -> Result<Storage, String> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Use at least {MIN_PASSPHRASE} characters"));
    }
    let (db, wrapped, marker) = paths(dir);
    if !db.exists() {
        return Err("This device isn't saved to disk, so there's nothing to protect".into());
    }
    let file = Wrapped::seal(key, passphrase)?;
    let tmp = dir.join("device.key.new");
    std::fs::write(&tmp, serde_json::to_vec(&file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &wrapped).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&marker);
    let _ = with_timeout(|| {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).and_then(|e| e.delete_credential())
    });
    Ok(Storage::Saved {
        path: db.display().to_string(),
        lock: "passphrase".into(),
    })
}

#[derive(Serialize, Deserialize)]
struct Wrapped {
    v: u8,
    /// Argon2id parameters, so they can be raised later without breaking old files.
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    sealed: String,
}

impl Wrapped {
    fn kek(passphrase: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
        let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| e.to_string())?;
        let mut out = [0u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(passphrase.as_bytes(), salt, &mut out)
            .map_err(|e| e.to_string())?;
        Ok(out)
    }

    fn seal(key: &[u8; 32], passphrase: &str) -> Result<Self, String> {
        let (m_kib, t, p) = (64 * 1024, 3, 1);
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let kek = Self::kek(passphrase, &salt, m_kib, t, p)?;
        let sealed = XChaCha20Poly1305::new((&kek).into())
            .encrypt(XNonce::from_slice(&nonce), key.as_slice())
            .map_err(|_| "encryption failed")?;
        Ok(Self {
            v: 1,
            m_kib,
            t,
            p,
            salt: to_hex(&salt),
            nonce: to_hex(&nonce),
            sealed: to_hex(&sealed),
        })
    }

    fn open(&self, passphrase: &str) -> Result<[u8; 32], String> {
        let bytes = |s: &str| from_hex_vec(s).ok_or("device.key is damaged");
        let (salt, nonce, sealed) = (bytes(&self.salt)?, bytes(&self.nonce)?, bytes(&self.sealed)?);
        if nonce.len() != 24 {
            return Err("device.key is damaged".into());
        }
        let kek = Self::kek(passphrase, &salt, self.m_kib, self.t, self.p)?;
        let key = XChaCha20Poly1305::new((&kek).into())
            .decrypt(XNonce::from_slice(&nonce), sealed.as_slice())
            .map_err(|_| "That passphrase isn't right")?;
        key.try_into().map_err(|_| "device.key is damaged".to_string())
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex_vec(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

fn from_hex(s: &str) -> Option<[u8; 32]> {
    from_hex_vec(s)?.try_into().ok()
}

/// Runs a keychain call on its own thread and gives up after [`KEYCHAIN_TIMEOUT`].
fn with_timeout<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(KEYCHAIN_TIMEOUT).map_err(|_| {
        format!(
            "the system keychain didn't answer within {} seconds",
            KEYCHAIN_TIMEOUT.as_secs()
        )
    })
}

fn open_with_keychain(path: &Path) -> Result<(Device, [u8; 32]), String> {
    let (entry, found) = with_timeout(|| match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => {
            let found = entry.get_password();
            (Some(entry), found)
        }
        Err(e) => (None, Err(e)),
    })?;

    match found {
        Ok(hex) => {
            let key = from_hex(&hex).ok_or("the keychain entry for this device is corrupted")?;
            Ok((
                Device::open_or_create(path, &key).map_err(|e| e.to_string())?,
                key,
            ))
        }
        Err(keyring::Error::NoEntry) => {
            if path.exists() {
                // Never overwrite a device we can't open: its owner may restore the key.
                return Err(format!(
                    "{} exists but its key is missing from the keychain; move it aside to start fresh",
                    path.display()
                ));
            }
            let key = random_key();
            let hex = to_hex(&key);
            let entry = entry.expect("a NoEntry answer comes from an entry that exists");
            with_timeout(move || entry.set_password(&hex))?
                .map_err(|e| format!("can't save the key to the keychain ({e})"))?;
            Ok((Device::create(path, &key).map_err(|e| e.to_string())?, key))
        }
        Err(e) => Err(format!("the system keychain is unavailable ({e})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_and_rejects_garbage() {
        let key = [0xab; 32];
        assert_eq!(from_hex(&to_hex(&key)), Some(key));
        assert_eq!(from_hex("zz"), None);
        assert_eq!(from_hex(&"g".repeat(64)), None);
    }

    #[test]
    fn passphrase_wrapping() {
        let key = [7u8; 32];
        let w = Wrapped::seal(&key, "correct horse battery").unwrap();
        assert_eq!(w.open("correct horse battery").unwrap(), key);
        assert_eq!(
            w.open("wrong horse battery").unwrap_err(),
            "That passphrase isn't right"
        );
        assert!(
            !w.sealed.contains(&to_hex(&key)),
            "the key isn't stored in the clear"
        );
    }

    #[test]
    fn a_temporary_device_can_be_saved_with_a_passphrase_and_reopened() {
        let dir = std::env::temp_dir().join(format!("anarchy-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // No keychain in this test: go straight to the temporary path.
        let Opened::Ready(device, _, key) = temporary(&dir, "no keychain".into()) else {
            panic!()
        };
        let id = device.id();
        drop(device);
        assert!(set_passphrase(&dir, &key, "short").is_err());
        set_passphrase(&dir, &key, "a long enough passphrase").unwrap();
        assert!(matches!(open_device(&dir), Opened::Locked));
        assert!(unlock(&dir, "not it at all").is_err());
        let (device, storage, _) = unlock(&dir, "a long enough passphrase").unwrap();
        assert_eq!(device.id(), id);
        assert!(matches!(storage, Storage::Saved { ref lock, .. } if lock == "passphrase"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
