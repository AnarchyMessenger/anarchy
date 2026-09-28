//! Where the device lives: an encrypted file in the app's data folder, with its
//! key in the OS keychain (macOS Keychain, Windows Credential Manager, Secret
//! Service on Linux). The key never touches the disk.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use anarchy_core::Device;
use serde::Serialize;

const KEYCHAIN_SERVICE: &str = "org.anarchymessenger.desktop";
const KEYCHAIN_ACCOUNT: &str = "device-database-key";
/// A keychain that hasn't answered by now isn't going to (a locked or missing
/// Secret Service can hang for many seconds). Better a clear message than a frozen app.
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Storage {
    /// Encrypted on disk, key in the OS keychain.
    Saved { path: String },
    /// In memory only; everything is lost on quit. `reason` is shown to the user.
    Temporary { reason: String },
}

/// Opens the saved device, or falls back to a temporary one and says why.
pub fn open_device(dir: &Path) -> (Device, Storage) {
    match open_saved_device(dir) {
        Ok((device, path)) => (device, Storage::Saved { path }),
        Err(reason) => {
            eprintln!("anarchy: running with a temporary device: {reason}");
            let device = Device::new().expect("can't create even an in-memory device");
            (device, Storage::Temporary { reason })
        }
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    if s.len() != 64 {
        return None;
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
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

fn open_saved_device(dir: &Path) -> Result<(Device, String), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let path = dir.join("device.db");
    let (entry, found) = with_timeout(|| match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => {
            let found = entry.get_password();
            (Some(entry), found)
        }
        Err(e) => (None, Err(e)),
    })?;

    let device = match found {
        Ok(hex) => {
            let key = from_hex(&hex).ok_or("the keychain entry for this device is corrupted")?;
            Device::open_or_create(&path, &key).map_err(|e| e.to_string())?
        }
        Err(keyring::Error::NoEntry) => {
            if path.exists() {
                // Never overwrite a device we can't open: its owner may restore the key.
                return Err(format!(
                    "{} exists but its key is missing from the keychain; move it aside to start fresh",
                    path.display()
                ));
            }
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(|e| e.to_string())?;
            let hex = to_hex(&key);
            let entry = entry.expect("a NoEntry answer comes from an entry that exists");
            with_timeout(move || entry.set_password(&hex))?
                .map_err(|e| format!("can't save the key to the keychain ({e})"))?;
            Device::create(&path, &key).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(format!("the system keychain is unavailable ({e})")),
    };
    Ok((device, path.display().to_string()))
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
}
