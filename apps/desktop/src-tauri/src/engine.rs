//! The engine: one thread that owns the device and the client.
//!
//! `Device` holds SQLite connections, which may move between threads but not be
//! shared by them. So instead of sharing, one thread owns everything and Tauri
//! commands send it jobs. Startup no longer waits on anything: the window paints
//! at once, the engine unlocks the device in the background, and jobs that
//! arrive before it's ready simply queue.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use anarchy_core::{Client, Device};
use anarchy_proto::{ChannelId, ChannelMeta, DeviceId, Member, Profile, Session};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::storage::{self, Storage};

pub type LocalFut<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + 'a>>;
type Job = Box<dyn for<'a> FnOnce(&'a mut Inner) -> Pin<Box<dyn Future<Output = ()> + 'a>> + Send>;

/// A signed-in session, saved (encrypted) in the device database.
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub server: String,
    pub org_name: String,
    pub session: Session,
    pub display_name: Option<String>,
    pub email: Option<String>,
}

// One instance per app, moved only on sign-in and sign-out: variant size doesn't matter.
#[allow(clippy::large_enum_variant)]
pub enum Account {
    SignedOut(Device),
    SignedIn(Box<Client>, SavedSession),
    /// Only while an operation moves the device between states.
    Moving,
}

/// Shows a desktop notification (title, body). Set by the app; a no-op in tests.
pub type Notifier = Box<dyn Fn(String, String) + Send>;

pub struct Inner {
    pub account: Account,
    pub storage: Storage,
    pub data_dir: PathBuf,
    /// The device database key, kept so a passphrase can be set later.
    pub key: Option<[u8; 32]>,
    /// Space or DM peer per channel, from the server.
    pub metas: HashMap<ChannelId, ChannelMeta>,
    /// The signed-in person's profile, refreshed on sign-in and on change.
    pub profile: Option<Profile>,
    /// Display names by device, per channel, from the server's member lists.
    pub members: HashMap<ChannelId, Vec<Member>>,
    /// The channel on screen: no notifications for it.
    pub focused: Option<ChannelId>,
    pub notify: Notifier,
}

impl Inner {
    pub fn device(&self) -> &Device {
        match &self.account {
            Account::SignedOut(d) => d,
            Account::SignedIn(c, _) => c.device(),
            Account::Moving => unreachable!("account is only Moving inside an operation"),
        }
    }

    pub fn client(&mut self) -> Result<&mut Client, String> {
        match &mut self.account {
            Account::SignedIn(c, _) => Ok(c),
            _ => Err("You're signed out".into()),
        }
    }

    pub fn saved(&self) -> Option<&SavedSession> {
        match &self.account {
            Account::SignedIn(_, s) => Some(s),
            _ => None,
        }
    }

    /// Waiting for the passphrase: only `status` and `unlock` make sense.
    pub fn is_locked(&self) -> bool {
        matches!(self.storage, Storage::Locked)
    }

    /// Replaces the placeholder with the real device after unlocking.
    pub fn unlocked(&mut self, device: Device, storage: Storage, key: [u8; 32]) {
        self.account = resume(device);
        self.storage = storage;
        self.key = Some(key);
    }

    pub fn my_device(&self) -> DeviceId {
        self.device().id()
    }
}

pub fn read_json<T: for<'de> Deserialize<'de>>(device: &Device, key: &str) -> Option<T> {
    device
        .setting(key)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_slice(&v).ok())
}

pub fn write_json<T: Serialize>(device: &Device, key: &str, value: &T) -> Result<(), String> {
    device
        .set_setting(key, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct Engine {
    tx: mpsc::UnboundedSender<Job>,
}

impl Engine {
    /// Starts the engine thread. It opens the device (keychain lookup included)
    /// before taking its first job; the caller returns immediately.
    pub fn start(data_dir: PathBuf, notify: Notifier) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        std::thread::Builder::new()
            .name("anarchy-engine".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("engine runtime");
                runtime.block_on(async move {
                    let (account, storage, key) = match storage::open_device(&data_dir) {
                        storage::Opened::Ready(device, storage, key) => (resume(device), storage, Some(key)),
                        // A throwaway stand-in until the passphrase opens the real one.
                        storage::Opened::Locked => (
                            Account::SignedOut(Device::new().expect("in-memory device")),
                            Storage::Locked,
                            None,
                        ),
                    };
                    let mut inner = Inner {
                        account,
                        storage,
                        data_dir,
                        key,
                        metas: HashMap::new(),
                        profile: None,
                        members: HashMap::new(),
                        focused: None,
                        notify,
                    };
                    while let Some(job) = rx.recv().await {
                        job(&mut inner).await;
                    }
                });
            })
            .expect("can't start the engine thread");
        Self { tx }
    }

    /// Runs `op` on the engine thread and waits for its answer.
    pub async fn run<T, F>(&self, op: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(&'a mut Inner) -> LocalFut<'a, T> + Send + 'static,
    {
        let (done, answer) = oneshot::channel();
        let job: Job = Box::new(move |inner| {
            Box::pin(async move {
                let _ = done.send(op(inner).await);
            })
        });
        self.tx
            .send(job)
            .map_err(|_| "the app is shutting down".to_string())?;
        answer.await.map_err(|_| "the app is shutting down".to_string())?
    }
}

/// Resumes a saved session unless it has expired (guests' end with their invite).
fn resume(device: Device) -> Account {
    match read_json::<SavedSession>(&device, "session") {
        Some(saved) if saved.session.expires_at_ms > now_ms() => {
            let client = Client::from_session(&saved.server, saved.session.clone(), device);
            Account::SignedIn(Box::new(client), saved)
        }
        Some(_) => {
            let _ = device.delete_setting("session");
            Account::SignedOut(device)
        }
        None => Account::SignedOut(device),
    }
}
