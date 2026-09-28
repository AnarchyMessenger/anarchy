// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;

use std::time::Duration;

use anarchy_core::{Client, Device, oidc};
use anarchy_proto::{AuthConfig, Session};
use serde::{Deserialize, Serialize};
use storage::Storage;
use tauri::Manager;
use tokio::sync::{Mutex, Notify};

/// How long the app waits for the browser to come back from the identity provider.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// A signed-in session, saved (encrypted) in the device database.
#[derive(Clone, Serialize, Deserialize)]
struct SavedSession {
    server: String,
    org_name: String,
    session: Session,
    /// Guests pick a display name; members get theirs from the identity provider.
    display_name: Option<String>,
}

/// Appearance: light/dark/system, plus the window frame colour.
#[derive(Clone, Serialize, Deserialize)]
struct Appearance {
    display: String,
    frame: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            display: "system".into(),
            frame: "cobalt".into(),
        }
    }
}

const FRAMES: [&str; 9] = [
    "cobalt", "spring", "summer", "autumn", "winter", "coral", "ocean", "forest", "dusk",
];

// One instance per app, moved only on sign-in and sign-out: variant size doesn't matter.
#[allow(clippy::large_enum_variant)]
enum Account {
    SignedOut(Device),
    SignedIn(Box<Client>, SavedSession),
    /// Only while a command moves the device between states.
    Moving,
}

struct AppState {
    account: Mutex<Account>,
    storage: Storage,
    cancel_sign_in: Notify,
}

#[derive(Serialize)]
struct Status {
    device_id: String,
    storage: Storage,
    appearance: Appearance,
    session: Option<SessionInfo>,
}

#[derive(Serialize)]
struct SessionInfo {
    server: String,
    org_name: String,
    is_guest: bool,
    display_name: Option<String>,
    expires_at_ms: u64,
}

fn device_of(account: &Account) -> &Device {
    match account {
        Account::SignedOut(d) => d,
        Account::SignedIn(c, _) => c.device(),
        Account::Moving => unreachable!("account is only Moving inside a command"),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(device: &Device, key: &str) -> Option<T> {
    device
        .setting(key)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_slice(&v).ok())
}

fn write_json<T: Serialize>(device: &Device, key: &str, value: &T) -> Result<(), String> {
    device
        .set_setting(key, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Accepts what people type ("chat.northwind.org", "https://…"). Plain http only for this computer.
fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err("Enter your workspace address, for example chat.northwind.org".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = reqwest_url(&with_scheme).ok_or("That doesn't look like a web address")?;
    let local = matches!(url.1.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match url.0.as_str() {
        "https" => Ok(with_scheme),
        "http" if local => Ok(with_scheme),
        "http" => Err("Use https:// for workspaces on other computers".into()),
        _ => Err("Workspace addresses start with https://".into()),
    }
}

/// (scheme, host) of a URL, without pulling in a URL crate.
fn reqwest_url(s: &str) -> Option<(String, String)> {
    let (scheme, rest) = s.split_once("://")?;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .rsplit_once('@')
        .map_or(rest, |(_, h)| h);
    let host = host.split('/').next()?;
    let host = if host.starts_with('[') {
        host.split_inclusive(']').next()?.to_owned()
    } else {
        host.split(':').next()?.to_owned()
    };
    if host.is_empty() || host.contains(' ') {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

// ---------- commands ----------

#[tauri::command]
async fn app_status(state: tauri::State<'_, AppState>) -> Result<Status, String> {
    let account = state.account.lock().await;
    let device = device_of(&account);
    let session = match &*account {
        Account::SignedIn(_, s) => Some(SessionInfo {
            server: s.server.clone(),
            org_name: s.org_name.clone(),
            is_guest: s.session.is_guest,
            display_name: s.display_name.clone(),
            expires_at_ms: s.session.expires_at_ms,
        }),
        _ => None,
    };
    Ok(Status {
        device_id: device.id().to_string(),
        storage: state.storage.clone(),
        appearance: read_json(device, "appearance").unwrap_or_default(),
        session,
    })
}

#[derive(Serialize)]
struct Workspace {
    server: String,
    config: AuthConfig,
}

#[tauri::command]
async fn workspace_info(server: String) -> Result<Workspace, String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(|e| match e {
        anarchy_core::Error::Http(_) => {
            format!("Couldn't reach {server}. Check the address and your connection.")
        }
        other => other.to_string(),
    })?;
    Ok(Workspace { server, config })
}

/// Opens the identity provider in the browser and waits for the user to come back.
#[tauri::command]
async fn sign_in_sso(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    server: String,
) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(|e| e.to_string())?;
    let pending = oidc::begin(&config).await.map_err(|e| e.to_string())?;
    if open::that_detached(&pending.url).is_err() {
        // No default browser (or it failed): let the person open the link themselves.
        let _ = tauri::Emitter::emit(&window, "sign-in-link", &pending.url);
    }
    let id_token = tokio::select! {
        r = pending.finish(SIGN_IN_TIMEOUT) => r.map_err(|e| e.to_string())?,
        _ = state.cancel_sign_in.notified() => return Err("Sign-in cancelled".into()),
    };
    let session = Client::login_with_id_token(&server, &id_token)
        .await
        .map_err(|e| e.to_string())?;
    attach(&state, server, config.org_name, session, None).await
}

#[tauri::command]
async fn cancel_sign_in(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.cancel_sign_in.notify_waiters();
    Ok(())
}

#[tauri::command]
async fn join_as_guest(
    state: tauri::State<'_, AppState>,
    server: String,
    code: String,
    name: String,
) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let config = oidc::workspace_config(&server).await.map_err(|e| e.to_string())?;
    let session = Client::login_as_guest(&server, &code, &name)
        .await
        .map_err(|e| match e {
            anarchy_core::Error::Api { message, .. } => message,
            other => other.to_string(),
        })?;
    attach(
        &state,
        server,
        config.org_name,
        session,
        Some(name.trim().to_owned()),
    )
    .await
}

/// Puts the device behind a new session, registers it and saves the session.
/// On failure the device goes back to the signed-out state, untouched.
async fn attach(
    state: &AppState,
    server: String,
    org_name: String,
    session: Session,
    display_name: Option<String>,
) -> Result<(), String> {
    let mut account = state.account.lock().await;
    let device = match std::mem::replace(&mut *account, Account::Moving) {
        Account::SignedOut(d) => d,
        Account::SignedIn(c, _) => (*c).into_device(),
        Account::Moving => unreachable!(),
    };
    let (id, key) = (device.id(), device.signature_public_key());
    if let Err(e) = Client::register(&server, &session, id, key).await {
        *account = Account::SignedOut(device);
        return Err(e.to_string());
    }
    let client = Client::from_session(&server, session.clone(), device);
    let saved = SavedSession {
        server,
        org_name,
        session,
        display_name,
    };
    if let Err(e) = write_json(client.device(), "session", &saved) {
        *account = Account::SignedOut(client.into_device());
        return Err(e);
    }
    *account = Account::SignedIn(Box::new(client), saved);
    Ok(())
}

#[tauri::command]
async fn set_appearance(
    state: tauri::State<'_, AppState>,
    display: String,
    frame: String,
) -> Result<(), String> {
    if !["light", "dark", "system", "luna"].contains(&display.as_str()) || !FRAMES.contains(&frame.as_str()) {
        return Err("unknown appearance".into());
    }
    let account = state.account.lock().await;
    write_json(device_of(&account), "appearance", &Appearance { display, frame })
}

/// Signs out of the workspace. The device, its keys and its channels stay on this computer.
#[tauri::command]
async fn sign_out(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut account = state.account.lock().await;
    *account = match std::mem::replace(&mut *account, Account::Moving) {
        Account::SignedIn(client, _) => {
            let device = (*client).into_device();
            device.delete_setting("session").map_err(|e| e.to_string())?;
            Account::SignedOut(device)
        }
        signed_out => signed_out, // already signed out: nothing to do
    };
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let (device, storage) = storage::open_device(&dir);
            // Resume a saved session unless it has expired (guests' end with their invite).
            let account = match read_json::<SavedSession>(&device, "session") {
                Some(saved) if saved.session.expires_at_ms > now_ms() => {
                    let client = Client::from_session(&saved.server, saved.session.clone(), device);
                    Account::SignedIn(Box::new(client), saved)
                }
                Some(_) => {
                    let _ = device.delete_setting("session");
                    Account::SignedOut(device)
                }
                None => Account::SignedOut(device),
            };
            app.manage(AppState {
                account: Mutex::new(account),
                storage,
                cancel_sign_in: Notify::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            workspace_info,
            sign_in_sso,
            cancel_sign_in,
            join_as_guest,
            set_appearance,
            sign_out
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anarchy");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_addresses_are_normalised() {
        assert_eq!(
            normalize_server(" chat.northwind.org/ ").unwrap(),
            "https://chat.northwind.org"
        );
        assert_eq!(
            normalize_server("https://chat.northwind.org").unwrap(),
            "https://chat.northwind.org"
        );
        assert_eq!(
            normalize_server("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(
            normalize_server("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(
            normalize_server("http://chat.northwind.org").is_err(),
            "no plain http across the network"
        );
        assert!(normalize_server("http://localhost.evil.test").is_err());
        assert!(
            normalize_server("http://evil.test@localhost").is_ok(),
            "userinfo is stripped; host is localhost"
        );
        assert!(normalize_server("ftp://chat.northwind.org").is_err());
        assert!(normalize_server("").is_err());
        assert!(normalize_server("not a url").is_err());
    }
}
