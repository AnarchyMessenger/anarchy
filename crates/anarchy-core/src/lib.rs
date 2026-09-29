//! Anarchy client core: device identity, MLS channels and sync.
//!
//! [`device`] holds the cryptography and has no I/O. [`client`] drives a device
//! against a server. Desktop (Tauri), mobile and web clients all build on this crate.

pub mod client;
pub mod content;
pub mod device;
pub mod files;
pub mod intake;
pub mod links;
pub mod oidc;

pub use client::{Client, Delivered};
pub use content::{Content, DeskItem, ItemRecord, Trust, fold_items};
pub use device::{Device, Incoming, PendingCommit, StoredMessage};

use anarchy_proto::{ChannelId, DeviceId};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("MLS error: {0}")]
    Mls(String),
    #[error("local storage error: {0}")]
    Storage(String),
    #[error("the key does not open this device's database")]
    WrongKey,
    #[error("sign-in failed: {0}")]
    SignIn(String),
    #[error("this device is not in channel {0}")]
    UnknownChannel(ChannelId),
    #[error("device {0} has no key packages left; it must publish more before it can be added")]
    NoKeyPackage(DeviceId),
    #[error("channel {channel} moved to epoch {current_epoch}; sync and retry")]
    StaleEpoch { channel: ChannelId, current_epoch: u64 },
    #[error("server refused the request ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
}
