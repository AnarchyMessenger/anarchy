//! Anarchy client core: device identity, MLS channels and sync.
//!
//! [`device`] holds the cryptography and has no I/O. [`client`] drives a device
//! against a server. Desktop (Tauri), mobile and web clients all build on this crate.

pub mod client;
pub mod device;

pub use client::{Client, Delivered};
pub use device::{Device, Incoming, PendingCommit};

use anarchy_proto::{ChannelId, DeviceId};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("MLS error: {0}")]
    Mls(String),
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
