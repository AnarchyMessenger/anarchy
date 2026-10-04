//! A local account (D38): Anarchy before any server.
//!
//! Someone who has no invite and no server can still start: they make a
//! profile on this computer and use everything that's theirs alone (Home, My
//! tasks, Agenda, Notes, Files, the Inbox and their email) without an account
//! anywhere. It's the signed-out device plus a saved profile (`local:profile`).
//! Their desks are channels that live only in the encrypted device database:
//! records are stored the way synced ones are, they just never leave. Files are
//! sealed per file exactly like drive files, and the sealed chunks stay on disk.
//!
//! The first time they sign in to a server, [`migrate`] moves all of it into
//! their account there: the profile, every desk record, and the files
//! (uploaded sealed, as usual). Then the local copies are dropped.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anarchy_core::{Client, Content, DeskItem, Device, ItemRecord, StoredMessage, fold_items};
use anarchy_proto::{ChannelId, DmPolicy, PresenceChoice, Profile, ProfileUpdate, Sidekick};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::engine::{now_ms, read_json, write_json};

/// What a local account knows about its person.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalProfile {
    pub display_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub usage: Option<anarchy_proto::Usage>,
    #[serde(default)]
    pub onboarded: bool,
    #[serde(default)]
    pub sidekick: Option<Sidekick>,
    pub created_ms: u64,
}

pub fn profile_of(device: &Device) -> Option<LocalProfile> {
    read_json(device, "local:profile")
}

/// The local account as the app shows any profile. The id is the device's.
pub fn as_profile(device: &Device, p: &LocalProfile) -> Profile {
    Profile {
        user_id: device.id(),
        display_name: p.display_name.clone(),
        username: p.username.clone(),
        tag: 0,
        color: p.color.clone().unwrap_or_else(|| "ember".into()),
        avatar: p.avatar.clone(),
        usage: p.usage,
        dm_policy: DmPolicy::Spaces,
        dm_humans_only: false,
        email: None,
        is_guest: false,
        is_anonymous: false,
        onboarded: p.onboarded,
        sidekick: p.sidekick.clone(),
        presence: PresenceChoice::Auto,
    }
}

fn clean_username(name: &str) -> String {
    let u: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                c
            } else {
                '.'
            }
        })
        .collect();
    let u = u.trim_matches('.').to_owned();
    if u.len() < 2 {
        "me".into()
    } else {
        u.chars().take(32).collect()
    }
}

/// Starts a local account on this device.
pub fn create(device: &Device, name: &str) -> Result<LocalProfile, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("Your name is 1 to 64 characters".into());
    }
    let p = LocalProfile {
        display_name: name.to_owned(),
        username: clean_username(name.split_whitespace().next().unwrap_or(name)),
        created_ms: now_ms(),
        ..Default::default()
    };
    write_json(device, "local:profile", &p)?;
    Ok(p)
}

/// Applies a profile change the way the server would, minus what needs one.
pub fn update(device: &Device, u: ProfileUpdate) -> Result<LocalProfile, String> {
    let mut p = profile_of(device).ok_or("No local account")?;
    if let Some(n) = u.display_name {
        let n = n.trim();
        if n.is_empty() || n.chars().count() > 64 {
            return Err("Your name is 1 to 64 characters".into());
        }
        p.display_name = n.to_owned();
    }
    if let Some(n) = u.username {
        let n = n.trim().to_lowercase();
        if !(2..=32).contains(&n.len())
            || !n
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
        {
            return Err("Usernames are 2 to 32 characters: letters, digits, _ and .".into());
        }
        p.username = n;
    }
    if let Some(c) = u.color {
        p.color = Some(c);
    }
    if let Some(a) = u.avatar {
        p.avatar = (!a.is_empty()).then_some(a);
    }
    if let Some(x) = u.usage {
        p.usage = Some(x);
    }
    if let Some(o) = u.onboarded {
        p.onboarded = o;
    }
    if let Some(sk) = u.sidekick {
        p.sidekick = (!sk.name.trim().is_empty()).then_some(sk);
    }
    write_json(device, "local:profile", &p)?;
    Ok(p)
}

/// Desk kind → local channel.
fn desks(device: &Device) -> BTreeMap<String, ChannelId> {
    read_json(device, "local:desks").unwrap_or_default()
}

pub fn desk_name(kind: &str) -> &'static str {
    match kind {
        "agenda" => "Agenda",
        "notes" => "Notes",
        "files" => "My files",
        "prefs" => "Preferences",
        _ => "Tasks",
    }
}

/// This person's local desk of `kind`, made the first time.
pub fn ensure_desk(device: &mut Device, kind: &str) -> Result<ChannelId, String> {
    let mut map = desks(device);
    if let Some(id) = map.get(kind) {
        return Ok(*id);
    }
    let id = Uuid::new_v4();
    device.create_channel(id).map_err(|e| e.to_string())?;
    let info = Content::ChannelInfo {
        name: desk_name(kind).into(),
        topic: String::new(),
        trust: anarchy_core::Trust::Sealed,
        desk: Some(kind.to_owned()),
    };
    store(device, id, &info)?;
    map.insert(kind.to_owned(), id);
    write_json(device, "local:desks", &map)?;
    Ok(id)
}

/// The local desks, as (channel, kind).
pub fn list(device: &Device) -> Vec<(ChannelId, String)> {
    desks(device).into_iter().map(|(k, id)| (id, k)).collect()
}

pub fn is_local(device: &Device, channel: ChannelId) -> bool {
    desks(device).values().any(|c| *c == channel)
}

fn store(device: &Device, channel: ChannelId, content: &Content) -> Result<(), String> {
    let seq = device.cursor(channel).map_err(|e| e.to_string())? + 1;
    device
        .store_message(
            channel,
            &StoredMessage {
                seq,
                sender: device.id(),
                ts_ms: now_ms(),
                content: content.encode(),
            },
        )
        .map_err(|e| e.to_string())?;
    device.set_cursor(channel, seq).map_err(|e| e.to_string())
}

pub fn items(device: &Device, channel: ChannelId) -> Result<Vec<DeskItem>, String> {
    let history = device.messages(channel, u32::MAX).map_err(|e| e.to_string())?;
    Ok(fold_items(
        history.iter().map(|m| (m.seq, m.ts_ms, m.content.as_slice())),
    ))
}

pub fn put(device: &Device, channel: ChannelId, items: Vec<ItemRecord>) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    store(device, channel, &Content::Items { items })
}

// ---------- files ----------

fn files_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("local-files")
}

/// Seals a file and keeps the sealed chunks on disk. Returns the record data.
pub fn store_file(data_dir: &std::path::Path, bytes: &[u8]) -> Result<serde_json::Value, String> {
    let (key, chunks) = anarchy_core::files::seal(bytes).map_err(|e| e.to_string())?;
    let dir = files_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut ids = Vec::with_capacity(chunks.len());
    for c in chunks {
        let id = Uuid::new_v4().to_string();
        std::fs::write(dir.join(&id), c).map_err(|e| e.to_string())?;
        ids.push(id);
    }
    Ok(serde_json::json!({ "file_key": key, "local_chunks": ids }))
}

pub fn read_file(data_dir: &std::path::Path, data: &serde_json::Value) -> Result<Vec<u8>, String> {
    let key: anarchy_core::files::FileKey =
        serde_json::from_value(data["file_key"].clone()).map_err(|_| "this record has no file")?;
    let ids: Vec<String> = serde_json::from_value(data["local_chunks"].clone())
        .map_err(|_| "this file isn't on this computer")?;
    let dir = files_dir(data_dir);
    let mut chunks = Vec::with_capacity(ids.len());
    for id in ids {
        // Ids are UUIDs we made; refuse anything else so a record can't point outside the folder.
        Uuid::parse_str(&id).map_err(|_| "bad file record")?;
        chunks.push(std::fs::read(dir.join(&id)).map_err(|e| e.to_string())?);
    }
    anarchy_core::files::open(&key, &chunks).map_err(|e| e.to_string())
}

// ---------- moving into a server account ----------

#[derive(Debug, Default, Serialize)]
pub struct Migrated {
    pub desks: usize,
    pub items: usize,
    pub files: usize,
}

/// Moves a local account into the server account `client` just signed in to:
/// the profile (where the server's is still blank), every desk record, and the
/// files. Then the local copies go. Safe to call when there's nothing local.
pub async fn migrate(client: &mut Client, data_dir: &std::path::Path) -> Result<Migrated, String> {
    let mut report = Migrated::default();
    let Some(p) = profile_of(client.device()) else {
        return Ok(report);
    };
    let me = client.me().await.map_err(|e| e.to_string())?;
    let update = ProfileUpdate {
        display_name: Some(p.display_name.clone()),
        username: (!p.username.is_empty() && p.username != me.username).then(|| p.username.clone()),
        color: p.color.clone(),
        avatar: p.avatar.clone(),
        usage: p.usage,
        onboarded: Some(p.onboarded || me.onboarded),
        sidekick: p.sidekick.clone(),
        ..Default::default()
    };
    // A taken username isn't worth failing over: keep the server's.
    if client.update_me(&update).await.is_err() {
        client
            .update_me(&ProfileUpdate {
                username: None,
                ..update
            })
            .await
            .map_err(|e| e.to_string())?;
    }
    for (local_id, kind) in list(client.device()) {
        let records = items(client.device(), local_id)?;
        let remote = client
            .create_personal_desk(desk_name(&kind), &kind)
            .await
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(records.len());
        for r in records {
            let mut data = r.data;
            if r.kind == "file" && data.get("local_chunks").is_some() {
                let bytes = read_file(data_dir, &data)?;
                let up = client
                    .upload_file(remote, &bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                data["file_key"] = up["file_key"].clone();
                data["chunks"] = up["chunks"].clone();
                if let Some(o) = data.as_object_mut() {
                    o.remove("local_chunks");
                }
                report.files += 1;
            }
            out.push(ItemRecord {
                id: r.id,
                kind: r.kind,
                data,
            });
        }
        report.items += out.len();
        // Large desks go in batches, so no single message gets huge.
        for batch in out.chunks(50) {
            client
                .send_content(
                    remote,
                    &Content::Items {
                        items: batch.to_vec(),
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        client.forget_channel(local_id).map_err(|e| e.to_string())?;
        report.desks += 1;
    }
    for k in ["local:profile", "local:desks"] {
        client.device().delete_setting(k).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(files_dir(data_dir));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_account_keeps_desks_and_files_on_the_device() {
        let dir = std::env::temp_dir().join(format!("anarchy-local-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut device = Device::new().unwrap();
        assert!(profile_of(&device).is_none());
        let p = create(&device, "Maya Chen").unwrap();
        assert_eq!(p.username, "maya");
        let tasks = ensure_desk(&mut device, "tasks").unwrap();
        assert_eq!(ensure_desk(&mut device, "tasks").unwrap(), tasks, "made once");
        assert!(is_local(&device, tasks));
        put(
            &device,
            tasks,
            vec![ItemRecord {
                id: "c1".into(),
                kind: "card".into(),
                data: serde_json::json!({ "title": "Renew passport" }),
            }],
        )
        .unwrap();
        put(
            &device,
            tasks,
            vec![ItemRecord {
                id: "c1".into(),
                kind: "card".into(),
                data: serde_json::json!({ "title": "Renew passport", "column": "done" }),
            }],
        )
        .unwrap();
        let got = items(&device, tasks).unwrap();
        assert_eq!(got.len(), 1, "the later write wins");
        assert_eq!(got[0].data["column"], "done");

        let data = store_file(&dir, b"hello local file").unwrap();
        assert_eq!(read_file(&dir, &data).unwrap(), b"hello local file");
        // The bytes on disk are sealed.
        let chunk = std::fs::read(
            dir.join("local-files")
                .join(data["local_chunks"][0].as_str().unwrap()),
        )
        .unwrap();
        assert!(!chunk.windows(5).any(|w| w == b"hello"));
        // A record can't point outside the folder.
        let mut evil = data.clone();
        evil["local_chunks"] = serde_json::json!(["../../etc/passwd"]);
        assert!(read_file(&dir, &evil).is_err());

        let p = update(
            &device,
            ProfileUpdate {
                username: Some("maya.chen".into()),
                onboarded: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((p.username.as_str(), p.onboarded), ("maya.chen", true));
        assert!(
            update(
                &device,
                ProfileUpdate {
                    username: Some("No Spaces!".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// Needs the test Postgres (`ANARCHY_TEST_DATABASE_URL`); skipped without it.
    #[tokio::test]
    async fn signing_in_moves_the_local_account_into_the_server_account() {
        if std::env::var("ANARCHY_TEST_DATABASE_URL").is_err() {
            eprintln!("skipped: set ANARCHY_TEST_DATABASE_URL");
            return;
        }
        let server = anarchy_testkit::TestServer::start().await;
        let dir = std::env::temp_dir().join(format!("anarchy-local-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut device = Device::new().unwrap();
        create(&device, "Maya Chen").unwrap();
        update(
            &device,
            ProfileUpdate {
                color: Some("ocean".into()),
                onboarded: Some(true),
                sidekick: Some(Sidekick {
                    name: "Pip".into(),
                    look: "s2.case.stern.b07150.100.100.0.a".into(),
                }),
                ..Default::default()
            },
        )
        .unwrap();
        let tasks = ensure_desk(&mut device, "tasks").unwrap();
        let files = ensure_desk(&mut device, "files").unwrap();
        put(
            &device,
            tasks,
            vec![ItemRecord {
                id: "c1".into(),
                kind: "card".into(),
                data: serde_json::json!({ "title": "Renew passport", "column": "todo" }),
            }],
        )
        .unwrap();
        let mut f = store_file(&dir, b"rate card 2026").unwrap();
        f["name"] = serde_json::json!("rates.txt");
        put(
            &device,
            files,
            vec![ItemRecord {
                id: "f1".into(),
                kind: "file".into(),
                data: f,
            }],
        )
        .unwrap();

        let token = server.idp.id_token("maya", "maya");
        let mut client = Client::sign_in(&server.url, &token, device).await.unwrap();
        let m = migrate(&mut client, &dir).await.unwrap();
        assert_eq!((m.desks, m.items, m.files), (2, 2, 1));

        let me = client.me().await.unwrap();
        assert_eq!(me.display_name, "Maya Chen");
        assert_eq!(me.color, "ocean");
        assert!(me.onboarded);
        assert_eq!(me.sidekick.map(|s| s.name), Some("Pip".into()));
        assert!(profile_of(client.device()).is_none(), "the local account is gone");
        assert!(list(client.device()).is_empty());
        assert!(
            !dir.join("local-files").exists(),
            "sealed local chunks are deleted"
        );

        // The desks are now personal channels on the server, records and file included.
        let metas = client.channel_metas().await.unwrap();
        let mut found_card = false;
        for meta in metas {
            for item in client.desk_items(meta.id).unwrap() {
                if item.id == "c1" {
                    found_card = item.data["title"] == "Renew passport";
                }
                if item.id == "f1" {
                    assert!(item.data.get("local_chunks").is_none());
                    assert_eq!(
                        client.download_file(meta.id, &item.data).await.unwrap(),
                        b"rate card 2026"
                    );
                }
            }
        }
        assert!(found_card);
        // Nothing left to move: a second call does nothing.
        assert_eq!(migrate(&mut client, &dir).await.unwrap().desks, 0);
    }
}
