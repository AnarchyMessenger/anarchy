// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod ops;
mod storage;

use std::sync::Arc;

use anarchy_core::Trust;
use anarchy_proto::{ChannelId, DeviceId, ProfileUpdate, SpaceId, SpaceKind, UserId};
use engine::Engine;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

struct AppState {
    engine: Engine,
    cancel_sign_in: Arc<Notify>,
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
op!(create_space(name: String, kind: SpaceKind) -> anarchy_proto::SpaceSummary);
op!(join_space(code: String) -> anarchy_proto::SpaceSummary);
op!(create_space_invite(space: SpaceId, hours: u64, max_uses: u32) -> ops::InviteView);
op!(start_dm(handle: String) -> ChannelId);
op!(workspace_info(server: String) -> ops::Workspace);
op!(request_email_code(server: String, email: String) -> ());
op!(sign_in_email(server: String, email: String, code: String) -> ());
op!(join_as_guest(server: String, code: String, name: String) -> ());
op!(sign_out() -> ());
op!(set_appearance(display: String, frame: String) -> ());
op!(set_notifications(prefs: ops::NotificationPrefs) -> ());
op!(list_channels() -> Vec<ops::ChannelView>);
op!(open_channel(channel: ChannelId) -> Vec<ops::MessageView>);
op!(blur() -> ());
op!(send_message(channel: ChannelId, text: String) -> ());
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

#[tauri::command]
async fn cancel_sign_in(state: tauri::State<'_, AppState>) -> R<()> {
    state.cancel_sign_in.notify_waiters();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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
            create_space,
            join_space,
            create_space_invite,
            start_dm,
            workspace_info,
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
