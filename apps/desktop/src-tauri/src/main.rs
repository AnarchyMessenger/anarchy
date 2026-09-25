// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use anarchy_core::Device;
use serde::Serialize;

/// Phase 0: one in-memory device per app run. Persistence (SQLCipher) comes in phase 1.
struct AppState {
    device: Mutex<Device>,
}

#[derive(Serialize)]
struct DeviceInfo {
    id: String,
    ciphersuite: &'static str,
}

#[tauri::command]
fn device_info(state: tauri::State<'_, AppState>) -> DeviceInfo {
    let device = state.device.lock().expect("device lock poisoned");
    DeviceInfo {
        id: device.id().to_string(),
        ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    }
}

fn main() {
    let device = Device::new().expect("failed to generate device keys");
    tauri::Builder::default()
        .manage(AppState {
            device: Mutex::new(device),
        })
        .invoke_handler(tauri::generate_handler![device_info])
        .run(tauri::generate_context!())
        .expect("error while running Anarchy");
}
