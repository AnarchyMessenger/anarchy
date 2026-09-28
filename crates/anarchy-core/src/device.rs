//! A device's keys and its MLS channel groups, kept in an encrypted local database.
//!
//! All state (signature key, MLS group secrets, pending key packages, channel
//! list, sync cursors) lives in one SQLCipher file, encrypted with a 32-byte key
//! the application supplies: from the OS keychain on desktop, from a secret
//! store for the Brain. No network I/O happens in this module.

use std::path::Path;

use anarchy_proto::{ChannelId, DeviceId};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use openmls_sqlite_storage::{Codec, SqliteStorageProvider};
use openmls_traits::OpenMlsProvider;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::Error;

/// X25519 + AES-128-GCM + SHA-256 + Ed25519: the MLS mandatory-to-implement suite.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Result of processing one incoming channel event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    Message(Vec<u8>),
    /// A commit was applied; the channel moved to a new epoch (membership or keys changed).
    EpochAdvanced,
    /// This device was removed from the channel. Its local copy of the group is deleted.
    Removed,
}

/// A commit this device produced and has not yet applied. Apply it with
/// [`Device::confirm_commit`] once the server accepts it, or drop it with
/// [`Device::discard_commit`] if the server reports a newer epoch.
pub struct PendingCommit {
    pub channel: ChannelId,
    /// The epoch the commit builds on; send it with the append request.
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct JsonCodec;

impl Codec for JsonCodec {
    type Error = serde_json::Error;

    fn to_vec<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, Self::Error> {
        serde_json::to_vec(value)
    }

    fn from_slice<T: serde::de::DeserializeOwned>(slice: &[u8]) -> Result<T, Self::Error> {
        serde_json::from_slice(slice)
    }
}

type Storage = SqliteStorageProvider<JsonCodec, Connection>;

/// OpenMLS provider: RustCrypto primitives over SQLCipher-backed storage.
struct Provider {
    crypto: RustCrypto,
    storage: Storage,
}

impl OpenMlsProvider for Provider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = Storage;

    fn storage(&self) -> &Storage {
        &self.storage
    }
    fn crypto(&self) -> &RustCrypto {
        &self.crypto
    }
    fn rand(&self) -> &RustCrypto {
        &self.crypto
    }
}

pub struct Device {
    id: DeviceId,
    provider: Provider,
    /// Second connection to the same database for Anarchy's own tables.
    meta: Connection,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    channels: std::collections::HashMap<ChannelId, MlsGroup>,
}

fn mls<E: std::fmt::Display>(e: E) -> Error {
    Error::Mls(e.to_string())
}

fn db(e: rusqlite::Error) -> Error {
    Error::Storage(e.to_string())
}

/// Opens (or creates) a SQLCipher database and checks the key.
fn open_encrypted(path: Option<&Path>, key: &[u8; 32]) -> Result<Connection, Error> {
    let conn = match path {
        Some(p) => Connection::open(p).map_err(db)?,
        None => Connection::open_in_memory().map_err(db)?,
    };
    // A raw 256-bit key, so SQLCipher skips its password KDF.
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    conn.pragma_update(None, "key", format!("x'{hex}'")).map_err(db)?;
    let cipher: Option<String> = conn
        .query_row("PRAGMA cipher_version", [], |r| r.get(0))
        .optional()
        .map_err(db)?;
    if cipher.is_none() {
        return Err(Error::Storage(
            "SQLite was built without SQLCipher; refusing to store keys unencrypted".into(),
        ));
    }
    // Reading the schema fails with the wrong key ("file is not a database").
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .map_err(|_| Error::WrongKey)?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(db)?;
    Ok(conn)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS anarchy_device (
    singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
    id                    BLOB NOT NULL,
    signature_public_key  BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS anarchy_channels (
    channel_id  BLOB PRIMARY KEY,
    cursor      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS anarchy_settings (
    key    TEXT PRIMARY KEY,
    value  BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS anarchy_messages (
    channel_id  BLOB NOT NULL,
    seq         INTEGER NOT NULL,
    sender      BLOB NOT NULL,
    ts_ms       INTEGER NOT NULL,
    content     BLOB NOT NULL,
    PRIMARY KEY (channel_id, seq)
);";

/// A decrypted message kept in local history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub seq: u64,
    pub sender: DeviceId,
    pub ts_ms: u64,
    /// Encoded [`crate::Content`].
    pub content: Vec<u8>,
}

impl Device {
    /// A throwaway device held in memory (tests, previews). Nothing survives the process.
    pub fn new() -> Result<Self, Error> {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).map_err(|e| Error::Storage(e.to_string()))?;
        Self::init(None, &key)
    }

    /// Creates a new device whose state is stored, encrypted with `key`, at `path`.
    pub fn create(path: &Path, key: &[u8; 32]) -> Result<Self, Error> {
        if path.exists() {
            return Err(Error::Storage(format!("{} already exists", path.display())));
        }
        Self::init(Some(path), key)
    }

    /// Opens an existing device. Fails with [`Error::WrongKey`] if `key` doesn't decrypt it.
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self, Error> {
        if !path.exists() {
            return Err(Error::Storage(format!("{} does not exist", path.display())));
        }
        let meta = open_encrypted(Some(path), key)?;
        meta.execute_batch(SCHEMA).map_err(db)?; // adds tables introduced after this device was created
        let storage = Self::storage(Some(path), key)?;
        let (id, public): (Vec<u8>, Vec<u8>) = meta
            .query_row("SELECT id, signature_public_key FROM anarchy_device", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(db)?;
        let id = Uuid::from_slice(&id).map_err(|e| Error::Storage(e.to_string()))?;
        let signer = SignatureKeyPair::read(&storage, &public, CIPHERSUITE.signature_algorithm())
            .ok_or_else(|| Error::Storage("signature key missing from device database".into()))?;

        let mut channels = std::collections::HashMap::new();
        let ids: Vec<Vec<u8>> = meta
            .prepare("SELECT channel_id FROM anarchy_channels")
            .map_err(db)?
            .query_map([], |r| r.get(0))
            .map_err(db)?
            .collect::<Result<_, _>>()
            .map_err(db)?;
        for raw in ids {
            let channel = Uuid::from_slice(&raw).map_err(|e| Error::Storage(e.to_string()))?;
            let group = MlsGroup::load(&storage, &GroupId::from_slice(&raw))
                .map_err(mls)?
                .ok_or_else(|| Error::Storage(format!("MLS state for channel {channel} is missing")))?;
            channels.insert(channel, group);
        }

        Ok(Self {
            id,
            credential: credential(id, &public),
            provider: Provider {
                crypto: RustCrypto::default(),
                storage,
            },
            meta,
            signer,
            channels,
        })
    }

    /// Opens the device at `path`, creating it on first run.
    pub fn open_or_create(path: &Path, key: &[u8; 32]) -> Result<Self, Error> {
        if path.exists() {
            Self::open(path, key)
        } else {
            Self::create(path, key)
        }
    }

    fn storage(path: Option<&Path>, key: &[u8; 32]) -> Result<Storage, Error> {
        let mut storage = Storage::new(open_encrypted(path, key)?);
        storage
            .run_migrations()
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(storage)
    }

    fn init(path: Option<&Path>, key: &[u8; 32]) -> Result<Self, Error> {
        let meta = open_encrypted(path, key)?;
        meta.execute_batch(SCHEMA).map_err(db)?;
        // In memory, `meta` and `storage` are two separate databases; each holds only its own tables.
        let storage = Self::storage(path, key)?;

        let id = Uuid::new_v4();
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls)?;
        signer.store(&storage).map_err(mls)?;
        let public = signer.to_public_vec();
        meta.execute(
            "INSERT INTO anarchy_device (singleton, id, signature_public_key) VALUES (1, ?1, ?2)",
            params![id.as_bytes().as_slice(), public],
        )
        .map_err(db)?;

        Ok(Self {
            id,
            credential: credential(id, &public),
            provider: Provider {
                crypto: RustCrypto::default(),
                storage,
            },
            meta,
            signer,
            channels: std::collections::HashMap::new(),
        })
    }

    pub fn id(&self) -> DeviceId {
        self.id
    }

    /// The Ed25519 public key this device signs MLS messages with.
    pub fn signature_public_key(&self) -> Vec<u8> {
        self.signer.to_public_vec()
    }

    /// Channels this device holds MLS state for.
    pub fn channels(&self) -> Vec<ChannelId> {
        let mut c: Vec<_> = self.channels.keys().copied().collect();
        c.sort();
        c
    }

    /// Keeps a decrypted message in local history (idempotent per sequence number).
    pub fn store_message(&self, channel: ChannelId, message: &StoredMessage) -> Result<(), Error> {
        self.meta
            .execute(
                "INSERT INTO anarchy_messages (channel_id, seq, sender, ts_ms, content) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT DO NOTHING",
                params![
                    channel.as_bytes().as_slice(),
                    message.seq as i64,
                    message.sender.as_bytes().as_slice(),
                    message.ts_ms as i64,
                    message.content
                ],
            )
            .map_err(db)?;
        Ok(())
    }

    /// The latest `limit` messages in a channel, oldest first.
    pub fn messages(&self, channel: ChannelId, limit: u32) -> Result<Vec<StoredMessage>, Error> {
        let mut stmt = self
            .meta
            .prepare(
                "SELECT seq, sender, ts_ms, content FROM
                   (SELECT * FROM anarchy_messages WHERE channel_id = ?1 ORDER BY seq DESC LIMIT ?2)
                 ORDER BY seq",
            )
            .map_err(db)?;
        let rows = stmt
            .query_map(params![channel.as_bytes().as_slice(), limit as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(db)?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, sender, ts_ms, content) = row.map_err(db)?;
            let sender = Uuid::from_slice(&sender).map_err(|e| Error::Storage(e.to_string()))?;
            out.push(StoredMessage {
                seq: seq as u64,
                sender,
                ts_ms: ts_ms as u64,
                content,
            });
        }
        Ok(out)
    }

    /// Reads an app setting (session, theme, …) from the encrypted database.
    pub fn setting(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        self.meta
            .query_row("SELECT value FROM anarchy_settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db)
    }

    pub fn set_setting(&self, key: &str, value: &[u8]) -> Result<(), Error> {
        self.meta
            .execute(
                "INSERT INTO anarchy_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), Error> {
        self.meta
            .execute("DELETE FROM anarchy_settings WHERE key = ?1", [key])
            .map_err(db)?;
        Ok(())
    }

    pub fn has_channel(&self, channel: ChannelId) -> bool {
        self.channels.contains_key(&channel)
    }

    /// Last sequence number applied in `channel` (0 if none).
    pub fn cursor(&self, channel: ChannelId) -> Result<u64, Error> {
        let c: Option<i64> = self
            .meta
            .query_row(
                "SELECT cursor FROM anarchy_channels WHERE channel_id = ?1",
                [channel.as_bytes()],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        Ok(c.unwrap_or(0) as u64)
    }

    pub fn set_cursor(&self, channel: ChannelId, seq: u64) -> Result<(), Error> {
        self.meta
            .execute(
                "UPDATE anarchy_channels SET cursor = ?2 WHERE channel_id = ?1",
                params![channel.as_bytes().as_slice(), seq as i64],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Single-use key packages that let other devices add this one to a channel.
    pub fn key_packages(&self, count: usize) -> Result<Vec<Vec<u8>>, Error> {
        (0..count)
            .map(|_| {
                let bundle = KeyPackage::builder()
                    .build(CIPHERSUITE, &self.provider, &self.signer, self.credential.clone())
                    .map_err(mls)?;
                bundle.key_package().tls_serialize_detached().map_err(mls)
            })
            .collect()
    }

    pub fn create_channel(&mut self, channel: ChannelId) -> Result<(), Error> {
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build();
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(channel.as_bytes()),
            self.credential.clone(),
        )
        .map_err(mls)?;
        self.track(channel, group)
    }

    fn track(&mut self, channel: ChannelId, group: MlsGroup) -> Result<(), Error> {
        self.meta
            .execute(
                "INSERT INTO anarchy_channels (channel_id) VALUES (?1) ON CONFLICT DO UPDATE SET cursor = 0",
                [channel.as_bytes()],
            )
            .map_err(db)?;
        self.channels.insert(channel, group);
        Ok(())
    }

    /// Deletes this device's copy of a channel: MLS secrets, cursor, everything.
    pub fn forget_channel(&mut self, channel: ChannelId) -> Result<(), Error> {
        if let Some(mut group) = self.channels.remove(&channel) {
            group.delete(self.provider.storage()).map_err(mls)?;
        }
        // Removal means losing access, history included (the Brain purges the same way).
        self.meta
            .execute(
                "DELETE FROM anarchy_messages WHERE channel_id = ?1",
                [channel.as_bytes()],
            )
            .map_err(db)?;
        self.meta
            .execute(
                "DELETE FROM anarchy_channels WHERE channel_id = ?1",
                [channel.as_bytes()],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn epoch(&self, channel: ChannelId) -> Result<u64, Error> {
        Ok(self.group(channel)?.epoch().as_u64())
    }

    /// Number of members in the channel's MLS group.
    pub fn member_count(&self, channel: ChannelId) -> Result<usize, Error> {
        Ok(self.group(channel)?.members().count())
    }

    /// Devices in the channel's MLS group, read from their credentials.
    pub fn member_devices(&self, channel: ChannelId) -> Result<Vec<DeviceId>, Error> {
        Ok(self
            .group(channel)?
            .members()
            .filter_map(|m| device_of(&m.credential))
            .collect())
    }

    /// Stages a commit adding the device behind `key_package` to `channel`.
    pub fn add_member(&mut self, channel: ChannelId, key_package: &[u8]) -> Result<PendingCommit, Error> {
        let key_package = KeyPackageIn::tls_deserialize_exact(key_package)
            .map_err(mls)?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(mls)?;
        let group = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        let epoch = group.epoch().as_u64();
        let (commit, welcome, _group_info) = group
            .add_members(&self.provider, &self.signer, core::slice::from_ref(&key_package))
            .map_err(mls)?;
        Ok(PendingCommit {
            channel,
            epoch,
            commit: commit.to_bytes().map_err(mls)?,
            welcome: Some(welcome.to_bytes().map_err(mls)?),
        })
    }

    /// Stages a commit removing `devices` from `channel`. The commit rotates the
    /// group's keys, so removed devices can't read anything sent afterwards.
    pub fn remove_members(
        &mut self,
        channel: ChannelId,
        devices: &[DeviceId],
    ) -> Result<PendingCommit, Error> {
        if devices.contains(&self.id) {
            return Err(Error::Mls(
                "a device can't remove itself; another member must".into(),
            ));
        }
        let group = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        let leaves: Vec<LeafNodeIndex> = group
            .members()
            .filter(|m| device_of(&m.credential).is_some_and(|d| devices.contains(&d)))
            .map(|m| m.index)
            .collect();
        if leaves.len() != devices.len() {
            return Err(Error::Mls(
                "some devices to remove are not in this channel".into(),
            ));
        }
        let epoch = group.epoch().as_u64();
        let (commit, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.signer, &leaves)
            .map_err(mls)?;
        Ok(PendingCommit {
            channel,
            epoch,
            commit: commit.to_bytes().map_err(mls)?,
            welcome: None,
        })
    }

    pub fn confirm_commit(&mut self, channel: ChannelId) -> Result<(), Error> {
        let group = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        group.merge_pending_commit(&self.provider).map_err(mls)
    }

    pub fn discard_commit(&mut self, channel: ChannelId) -> Result<(), Error> {
        let group = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        group.clear_pending_commit(self.provider.storage()).map_err(mls)
    }

    /// Joins a channel from a Welcome. Returns the channel it belongs to.
    pub fn join(&mut self, welcome: &[u8]) -> Result<ChannelId, Error> {
        let welcome = match MlsMessageIn::tls_deserialize_exact(welcome)
            .map_err(mls)?
            .extract()
        {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(Error::Mls("expected a Welcome message".into())),
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let group = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
            .map_err(mls)?
            .into_group(&self.provider)
            .map_err(mls)?;
        let channel = Uuid::from_slice(group.group_id().as_slice())
            .map_err(|_| Error::Mls("group id is not a channel id".into()))?;
        self.track(channel, group)?;
        Ok(channel)
    }

    /// Encrypts `plaintext` for the channel. Returns the epoch it was encrypted in and the ciphertext.
    pub fn encrypt(&mut self, channel: ChannelId, plaintext: &[u8]) -> Result<(u64, Vec<u8>), Error> {
        let group = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        let epoch = group.epoch().as_u64();
        let msg = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(mls)?;
        Ok((epoch, msg.to_bytes().map_err(mls)?))
    }

    /// Processes a commit or application message from another device.
    pub fn receive(&mut self, channel: ChannelId, bytes: &[u8]) -> Result<Incoming, Error> {
        let group = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(mls)?
            .try_into_protocol_message()
            .map_err(mls)?;
        let processed = group.process_message(&self.provider, message).map_err(mls)?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(m) => Ok(Incoming::Message(m.into_bytes())),
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                let removed = staged.self_removed();
                group.merge_staged_commit(&self.provider, *staged).map_err(mls)?;
                if removed {
                    self.forget_channel(channel)?;
                    Ok(Incoming::Removed)
                } else {
                    Ok(Incoming::EpochAdvanced)
                }
            }
            other => Err(Error::Mls(format!("unsupported message content: {other:?}"))),
        }
    }

    fn group(&self, channel: ChannelId) -> Result<&MlsGroup, Error> {
        self.channels.get(&channel).ok_or(Error::UnknownChannel(channel))
    }
}

fn credential(id: DeviceId, public: &[u8]) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(id.as_bytes().to_vec()).into(),
        signature_key: public.to_vec().into(),
    }
}

/// The device ID a member's basic credential carries.
fn device_of(credential: &Credential) -> Option<DeviceId> {
    Uuid::from_slice(credential.serialized_content()).ok()
}
