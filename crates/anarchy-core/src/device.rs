//! A device's keys and its MLS channel groups. No I/O here, so this module can
//! compile to WASM and be driven by any transport.

use std::collections::HashMap;

use anarchy_proto::{ChannelId, DeviceId};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
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

pub struct Device {
    id: DeviceId,
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    channels: HashMap<ChannelId, MlsGroup>,
}

fn mls<E: std::fmt::Display>(e: E) -> Error {
    Error::Mls(e.to_string())
}

impl Device {
    /// Generates a fresh device identity. The device ID doubles as the MLS credential identity.
    pub fn new() -> Result<Self, Error> {
        let id = Uuid::new_v4();
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls)?;
        signer.store(provider.storage()).map_err(mls)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(id.as_bytes().to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Ok(Self {
            id,
            provider,
            signer,
            credential,
            channels: HashMap::new(),
        })
    }

    pub fn id(&self) -> DeviceId {
        self.id
    }

    /// The Ed25519 public key this device signs MLS messages with.
    pub fn signature_public_key(&self) -> Vec<u8> {
        self.signer.to_public_vec()
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
        self.channels.insert(channel, group);
        Ok(())
    }

    pub fn has_channel(&self, channel: ChannelId) -> bool {
        self.channels.contains_key(&channel)
    }

    pub fn epoch(&self, channel: ChannelId) -> Result<u64, Error> {
        Ok(self.group(channel)?.epoch().as_u64())
    }

    /// Number of members in the channel's MLS group.
    pub fn member_count(&self, channel: ChannelId) -> Result<usize, Error> {
        Ok(self.group(channel)?.members().count())
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
        self.channels.insert(channel, group);
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
                group.merge_staged_commit(&self.provider, *staged).map_err(mls)?;
                Ok(Incoming::EpochAdvanced)
            }
            other => Err(Error::Mls(format!("unsupported message content: {other:?}"))),
        }
    }

    fn group(&self, channel: ChannelId) -> Result<&MlsGroup, Error> {
        self.channels.get(&channel).ok_or(Error::UnknownChannel(channel))
    }
}
