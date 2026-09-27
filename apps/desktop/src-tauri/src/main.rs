// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::sync::Mutex;

use anarchy_core::Device;
use serde::Serialize;
use tauri::Manager;

const KEYCHAIN_SERVICE: &str = "org.anarchymessenger.desktop";
const KEYCHAIN_ACCOUNT: &str = "device-database-key";

/// Where this run's device lives.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Storage {
    /// Encrypted on disk, key in the OS keychain.
    Saved { path: String },
    /// In memory only; everything is lost on quit. `reason` is shown to the user.
    Temporary { reason: String },
}

struct AppState {
    device: Mutex<Device>,
    storage: Storage,
}

#[derive(Serialize)]
struct DeviceInfo {
    id: String,
    ciphersuite: &'static str,
    storage: Storage,
}

#[tauri::command]
fn device_info(state: tauri::State<'_, AppState>) -> DeviceInfo {
    let device = state.device.lock().expect("device lock poisoned");
    DeviceInfo {
        id: device.id().to_string(),
        ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        storage: state.storage.clone(),
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

/// Opens the device saved in `dir`, creating it and its keychain entry on first run.
/// The database key never touches the disk.
fn open_saved_device(dir: &Path) -> Result<(Device, String), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let path = dir.join("device.db");
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("the system keychain is unavailable ({e})"))?;

    let device = match entry.get_password() {
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
            entry
                .set_password(&to_hex(&key))
                .map_err(|e| format!("can't save the key to the keychain ({e})"))?;
            Device::create(&path, &key).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(format!("the system keychain is unavailable ({e})")),
    };
    Ok((device, path.display().to_string()))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let (device, storage) = match open_saved_device(&dir) {
                Ok((device, path)) => (device, Storage::Saved { path }),
                Err(reason) => {
                    eprintln!("anarchy: running with a temporary device: {reason}");
                    (Device::new()?, Storage::Temporary { reason })
                }
            };
            app.manage(AppState {
                device: Mutex::new(device),
                storage,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![device_info])
        .run(tauri::generate_context!())
        .expect("error while running Anarchy");
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
