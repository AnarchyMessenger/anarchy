// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dav;
mod engine;
mod local;
mod ops;
mod storage;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anarchy_core::Trust;
use anarchy_proto::{ChannelId, DeviceId, ProfileUpdate, SpaceId, SpaceKind, UserId};
use engine::Engine;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

struct AppState {
    engine: Engine,
    cancel_sign_in: Arc<Notify>,
    /// Paths the person dropped on the window. Only these (or ones picked in the
    /// native dialog) can be uploaded, so the web view can't name arbitrary files.
    dropped: Arc<Mutex<HashSet<PathBuf>>>,
    /// The drive's local WebDAV share, while it's on.
    mount: Arc<tokio::sync::Mutex<Option<dav::Running>>>,
}

type R<T> = Result<T, String>;

/// Declares a Tauri command that runs an `ops` function on the engine thread.
/// While the device is locked, only `status` and `unlock` run.
macro_rules! op {
    ($name:ident ( $($arg:ident : $ty:ty),* ) -> $out:ty) => {
        #[tauri::command]
        async fn $name(state: tauri::State<'_, AppState> $(, $arg: $ty)*) -> R<$out> {
            state
                .engine
                .run(move |i| {
                    Box::pin(async move {
                        if i.is_locked() {
                            return Err("Unlock Anarchy first".to_string());
                        }
                        ops::$name(i $(, $arg)*).await
                    })
                })
                .await
        }
    };
}

#[tauri::command]
async fn status(state: tauri::State<'_, AppState>) -> R<ops::Status> {
    state.engine.run(|i| Box::pin(ops::status(i))).await
}

#[tauri::command]
async fn unlock(state: tauri::State<'_, AppState>, passphrase: String) -> R<()> {
    state
        .engine
        .run(move |i| Box::pin(ops::unlock(i, passphrase)))
        .await
}

op!(set_passphrase(passphrase: String) -> ());
op!(sign_in_anonymous(server: String, name: String) -> ());
op!(me() -> anarchy_proto::Profile);
op!(update_profile(update: ProfileUpdate) -> anarchy_proto::Profile);
op!(spaces() -> Vec<anarchy_proto::SpaceSummary>);
op!(rename_space(space: SpaceId, name: String) -> anarchy_proto::SpaceSummary);
op!(leave_space(space: SpaceId) -> ());
op!(notify(title: String, body: String) -> ());
op!(create_space(name: String, kind: SpaceKind) -> anarchy_proto::SpaceSummary);
op!(join_space(code: String) -> anarchy_proto::SpaceSummary);
op!(create_space_invite(space: SpaceId, hours: u64, max_uses: u32) -> ops::InviteView);
op!(start_dm(handle: String) -> ChannelId);
op!(sidekick_state(channel: ChannelId) -> ops::SidekickState);
op!(sidekick_join(channel: ChannelId) -> ());
op!(sidekick_leave(channel: ChannelId) -> ());
op!(sidekick_chat() -> ChannelId);
op!(heartbeat() -> ());
op!(start_local(name: String) -> anarchy_proto::Profile);
op!(mail_preset(email: String) -> Option<anarchy_mail::Preset>);
op!(mail_status() -> ops::MailStatus);
op!(mail_connect(account: anarchy_mail::Account) -> ());
op!(mail_disconnect() -> ());
op!(mail_list() -> Vec<anarchy_mail::Mail>);
op!(mail_sync() -> Vec<anarchy_mail::Mail>);
op!(mail_seen(uid: u32, seen: bool) -> ());
op!(mail_send(out: anarchy_mail::Outgoing) -> ());
op!(search(query: String) -> Vec<ops::SearchHit>);
op!(space_members(space: SpaceId) -> Vec<ops::PeerView>);
op!(ensure_drive(space: SpaceId) -> ChannelId);
op!(ensure_personal(kind: String) -> ChannelId);
op!(save_text_file(channel: ChannelId, id: String, text: String) -> ());
op!(preview_file(channel: ChannelId, id: String) -> ops::Preview);
op!(create_desk(space: Option<SpaceId>, name: String, kind: String) -> ChannelId);
op!(desk_items(channel: ChannelId) -> Vec<anarchy_core::DeskItem>);
op!(put_items(channel: ChannelId, items: Vec<anarchy_core::ItemRecord>) -> ());
op!(create_pay_link(channel: ChannelId, page: serde_json::Value, expires_at_ms: u64) -> ops::PayLinkView);
op!(update_pay_link(channel: ChannelId, url: String, page: serde_json::Value) -> ());
op!(pay_links(channel: ChannelId) -> Vec<anarchy_proto::PayLinkStatus>);
op!(revoke_pay_link(channel: ChannelId, id: String) -> ());
op!(new_form_keys() -> ops::FormKeys);
op!(create_form(channel: ChannelId, form: serde_json::Value, expires_at_ms: u64) -> ops::PayLinkView);
op!(update_form(channel: ChannelId, url: String, form: serde_json::Value) -> ());
op!(revoke_form(channel: ChannelId, id: String) -> ());
op!(form_answers(channel: ChannelId, id: String, private_key: String) -> Vec<ops::FormAnswer>);
op!(forget_form_answer(channel: ChannelId, id: String, sub: i64) -> ());
op!(compose_email(to: String, subject: String, body: String) -> ());
op!(workspace_info(server: String) -> ops::Workspace);
op!(discover_server(email: String) -> Option<String>);
op!(request_email_code(server: String, email: String) -> ());
op!(sign_in_email(server: String, email: String, code: String) -> ());
op!(join_as_guest(server: String, code: String, name: String) -> ());
op!(sign_out() -> ());
op!(set_appearance(display: String, frame: String) -> ());
op!(set_notifications(prefs: ops::NotificationPrefs) -> ());
op!(list_channels() -> Vec<ops::ChannelView>);
op!(open_channel(channel: ChannelId) -> Vec<ops::MessageView>);
op!(blur() -> ());
op!(send_message(channel: ChannelId, text: String, thread: Option<u64>) -> ());
op!(create_channel(space: Option<SpaceId>, name: String, topic: String, trust: Trust) -> ChannelId);
op!(sync_all() -> ops::SyncReport);
op!(people(channel: Option<ChannelId>) -> Vec<ops::Person>);
op!(channel_members(channel: ChannelId) -> Vec<ops::MemberView>);
op!(add_people(channel: ChannelId, users: Vec<UserId>) -> Vec<String>);
op!(remove_person(channel: ChannelId, user: UserId) -> ());
op!(devices() -> Vec<ops::DeviceView>);
op!(revoke_device(device: DeviceId) -> ());
op!(create_invite(hours: u64, max_uses: u32) -> ops::InviteView);

/// Opens the identity provider in the browser and waits for the person to come back.
#[tauri::command]
async fn sign_in_sso(state: tauri::State<'_, AppState>, window: tauri::Window, server: String) -> R<()> {
    let cancel = state.cancel_sign_in.clone();
    let show_link: Box<dyn Fn(String) + Send> = Box::new(move |url| {
        let _ = window.emit("sign-in-link", url);
    });
    state
        .engine
        .run(move |i| Box::pin(ops::sign_in_sso(i, server, cancel, show_link)))
        .await
}

async fn upload_all(
    state: &AppState,
    channel: ChannelId,
    folder: String,
    paths: Vec<PathBuf>,
) -> R<Vec<String>> {
    let mut done = Vec::new();
    for path in paths {
        let folder = folder.clone();
        let name = state
            .engine
            .run(move |i| {
                Box::pin(async move {
                    if i.is_locked() {
                        return Err("Unlock Anarchy first".to_string());
                    }
                    ops::upload_path(i, channel, path, folder).await
                })
            })
            .await?;
        done.push(name);
    }
    Ok(done)
}

/// Opens the system file picker and uploads what the person picks.
#[tauri::command]
async fn pick_and_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel: ChannelId,
    folder: String,
) -> R<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Upload to the drive")
            .blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect();
    upload_all(&state, channel, folder, paths).await
}

/// Uploads files the person dropped on the window.
#[tauri::command]
async fn upload_dropped(
    state: tauri::State<'_, AppState>,
    channel: ChannelId,
    folder: String,
    paths: Vec<String>,
) -> R<Vec<String>> {
    let allowed: Vec<PathBuf> = {
        let mut dropped = state.dropped.lock().map_err(|_| "busy".to_string())?;
        paths
            .into_iter()
            .map(PathBuf::from)
            .filter(|p| dropped.remove(p))
            .collect()
    };
    upload_all(&state, channel, folder, allowed).await
}

/// Asks where to save, then downloads and decrypts the file there.
#[tauri::command]
async fn save_file_as(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel: ChannelId,
    id: String,
    name: String,
) -> R<bool> {
    use tauri_plugin_dialog::DialogExt;
    let dest =
        tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(&name).blocking_save_file())
            .await
            .map_err(|e| e.to_string())?
            .and_then(|p| p.into_path().ok());
    let Some(dest) = dest else { return Ok(false) };
    state
        .engine
        .run(move |i| {
            Box::pin(async move {
                if i.is_locked() {
                    return Err("Unlock Anarchy first".to_string());
                }
                ops::save_file(i, channel, id, dest).await
            })
        })
        .await?;
    Ok(true)
}

#[derive(serde::Serialize)]
struct MountInfo {
    enabled: bool,
    running: bool,
    /// For macOS "Connect to Server" and Linux file managers.
    url: String,
    /// For Explorer's address bar or "Map network drive".
    windows: String,
}

fn mount_info_of(prefs: &dav::MountPrefs, running: Option<&dav::Running>) -> MountInfo {
    let (port, token) = running
        .map(|r| (r.port, r.token.clone()))
        .unwrap_or((prefs.port, prefs.token.clone()));
    let path = dav::prefix(&token);
    MountInfo {
        enabled: prefs.enabled,
        running: running.is_some(),
        url: if running.is_some() {
            format!("http://127.0.0.1:{port}{path}/")
        } else {
            String::new()
        },
        windows: if running.is_some() {
            format!("\\\\127.0.0.1@{port}\\DavWWWRoot{}", path.replace('/', "\\"))
        } else {
            String::new()
        },
    }
}

async fn mount_prefs(state: &AppState, update: Option<(bool, bool)>) -> R<dav::MountPrefs> {
    state
        .engine
        .run(move |i| {
            Box::pin(async move {
                if i.is_locked() {
                    return Err("Unlock Anarchy first".to_string());
                }
                let mut prefs: dav::MountPrefs = engine::read_json(i.device(), "mount").unwrap_or_default();
                if prefs.token.is_empty() {
                    prefs.token = dav::MountPrefs::new_token();
                }
                if let Some((enabled, new_address)) = update {
                    prefs.enabled = enabled;
                    if new_address {
                        prefs.token = dav::MountPrefs::new_token();
                    }
                }
                engine::write_json(i.device(), "mount", &prefs)?;
                Ok(prefs)
            })
        })
        .await
}

/// Starts or stops the share to match the saved setting.
async fn apply_mount(state: &AppState, mut prefs: dav::MountPrefs) -> R<MountInfo> {
    let mut running = state.mount.lock().await;
    let stale = running.as_ref().is_some_and(|r| r.token != prefs.token);
    if !prefs.enabled || stale {
        *running = None;
    }
    if prefs.enabled && running.is_none() {
        let r = dav::start(state.engine.clone(), &prefs).await?;
        if r.port != prefs.port {
            prefs.port = r.port;
            let saved = prefs.clone();
            state
                .engine
                .run(move |i| Box::pin(async move { engine::write_json(i.device(), "mount", &saved) }))
                .await?;
        }
        *running = Some(r);
    }
    Ok(mount_info_of(&prefs, running.as_ref()))
}

/// The share's state; starts it if it's on and not running yet (after unlock).
#[tauri::command]
async fn mount_info(state: tauri::State<'_, AppState>) -> R<MountInfo> {
    let prefs = mount_prefs(&state, None).await?;
    apply_mount(&state, prefs).await
}

#[tauri::command]
async fn set_mount(state: tauri::State<'_, AppState>, enabled: bool, new_address: bool) -> R<MountInfo> {
    let prefs = mount_prefs(&state, Some((enabled, new_address))).await?;
    apply_mount(&state, prefs).await
}

/// Mounts the share with the system's own WebDAV client and opens it.
#[tauri::command]
async fn open_mount(state: tauri::State<'_, AppState>) -> R<()> {
    let info = mount_info(state).await?;
    if !info.running {
        return Err("Turn on \"Files on this computer\" first".into());
    }
    tokio::task::spawn_blocking(move || open_share(&info))
        .await
        .map_err(|e| e.to_string())?
}

fn open_share(info: &MountInfo) -> R<()> {
    use std::process::Command;
    let run = |cmd: &mut Command| -> R<()> {
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    };
    if cfg!(target_os = "macos") {
        run(Command::new("osascript").args(["-e", &format!("mount volume \"{}\"", info.url)]))?;
        run(Command::new("open").arg("/Volumes/Anarchy"))
    } else if cfg!(target_os = "windows") {
        // Needs the WebClient service, which Windows starts on demand.
        run(Command::new("explorer").arg(&info.windows)).or(Ok(()))
    } else {
        let dav = info.url.replacen("http://", "dav://", 1);
        // Already mounted is fine.
        let _ = Command::new("gio").args(["mount", &dav]).output();
        run(Command::new("gio").args(["open", &dav])).or_else(|_| run(Command::new("xdg-open").arg(&dav)))
    }
}

#[tauri::command]
async fn cancel_sign_in(state: tauri::State<'_, AppState>) -> R<()> {
    state.cancel_sign_in.notify_waiters();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
                && let Some(state) = window.try_state::<AppState>()
                && let Ok(mut dropped) = state.dropped.lock()
            {
                dropped.extend(paths.iter().cloned());
            }
        })
        .setup(|app| {
            // Nothing slow here: the window paints now, the engine unlocks the device behind it.
            let dir = app.path().app_data_dir()?;
            let handle = app.handle().clone();
            let notify: engine::Notifier = Box::new(move |title, body| {
                let handle = handle.clone();
                // Desktop notification services can be slow to answer; never block the engine.
                std::thread::spawn(move || {
                    let _ = handle.notification().builder().title(title).body(body).show();
                });
            });
            app.manage(AppState {
                engine: Engine::start(dir, notify),
                cancel_sign_in: Arc::new(Notify::new()),
                dropped: Arc::new(Mutex::new(HashSet::new())),
                mount: Arc::new(tokio::sync::Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            unlock,
            set_passphrase,
            sign_in_anonymous,
            me,
            update_profile,
            spaces,
            rename_space,
            leave_space,
            notify,
            create_space,
            join_space,
            create_space_invite,
            start_dm,
            sidekick_state,
            sidekick_join,
            sidekick_leave,
            sidekick_chat,
            heartbeat,
            start_local,
            mail_preset,
            mail_status,
            mail_connect,
            mail_disconnect,
            mail_list,
            mail_sync,
            mail_seen,
            mail_send,
            search,
            space_members,
            ensure_drive,
            ensure_personal,
            save_text_file,
            preview_file,
            pick_and_upload,
            upload_dropped,
            save_file_as,
            mount_info,
            set_mount,
            open_mount,
            create_desk,
            desk_items,
            put_items,
            compose_email,
            create_pay_link,
            update_pay_link,
            pay_links,
            revoke_pay_link,
            new_form_keys,
            create_form,
            update_form,
            revoke_form,
            form_answers,
            forget_form_answer,
            workspace_info,
            discover_server,
            sign_in_sso,
            cancel_sign_in,
            request_email_code,
            sign_in_email,
            join_as_guest,
            sign_out,
            set_appearance,
            set_notifications,
            list_channels,
            open_channel,
            blur,
            send_message,
            create_channel,
            sync_all,
            people,
            channel_members,
            add_people,
            remove_person,
            devices,
            revoke_device,
            create_invite
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anarchy");
}
