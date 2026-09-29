//! The drive as a WebDAV share on 127.0.0.1, so Finder, Explorer and Linux
//! file managers can mount it like a network disk.
//!
//! Files are decrypted in this process when the OS reads them and encrypted
//! before anything leaves it; this module never writes plaintext to disk
//! (the OS's own WebDAV client may cache what it reads). Access needs the
//! secret first path segment, and requests must name the loopback host, so a
//! web page can't reach the share through the browser (CSRF, DNS rebinding).
//! Other programs running as the same person can, as with any mounted disk.

use std::collections::BTreeMap;
use std::io::SeekFrom;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anarchy_core::content::{DeskItem, ItemRecord};
use anarchy_proto::{ChannelId, SpaceId};
use bytes::Bytes;
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream, OpenOptions,
    ReadDirMeta,
};
use futures_util::{FutureExt, StreamExt};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::engine::{Engine, Inner, LocalFut, now_ms};
use crate::ops;

/// Saved in the device store: whether the share is on, and its address, so a
/// mount made once keeps working after a restart.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct MountPrefs {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl MountPrefs {
    pub fn new_token() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }
}

/// The share's root path. The last segment names the volume in Finder and
/// the folder in Explorer, so it reads "Anarchy" rather than the token.
pub fn prefix(token: &str) -> String {
    format!("/{token}/Anarchy")
}

pub struct Running {
    pub port: u16,
    pub token: String,
    _stop: oneshot::Sender<()>,
}

/// Starts serving; tries the saved port first so existing mounts keep working.
pub async fn start(engine: Engine, prefs: &MountPrefs) -> Result<Running, String> {
    let listener = match TcpListener::bind(("127.0.0.1", prefs.port)).await {
        Ok(l) if prefs.port != 0 => l,
        _ => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Can't open the local share: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = prefs.token.clone();
    let handler = dav_server::DavHandler::builder()
        .filesystem(Box::new(DriveFs::new(engine)))
        .locksystem(dav_server::fakels::FakeLs::new())
        .strip_prefix(prefix(&token))
        .build_handler();
    let (stop, mut stopped) = oneshot::channel::<()>();
    let hosts = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        "127.0.0.1".to_string(),
        "localhost".to_string(),
    ];
    let prefix = prefix(&token);
    tokio::spawn(async move {
        loop {
            let stream = tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => stream,
                    Err(_) => continue,
                },
            };
            let handler = handler.clone();
            let hosts = hosts.clone();
            let prefix = prefix.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    let handler = handler.clone();
                    let host_ok = req
                        .headers()
                        .get(hyper::header::HOST)
                        .and_then(|h| h.to_str().ok())
                        .is_some_and(|h| hosts.iter().any(|x| x.eq_ignore_ascii_case(h)));
                    let path = req.uri().path();
                    let path_ok = path == prefix || path.starts_with(&format!("{prefix}/"));
                    async move {
                        if !host_ok || !path_ok {
                            let mut res = hyper::Response::new(dav_server::body::Body::from("Not found"));
                            *res.status_mut() = hyper::StatusCode::NOT_FOUND;
                            return Ok::<_, std::convert::Infallible>(res);
                        }
                        Ok(handler.handle(req).await)
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(Running {
        port,
        token,
        _stop: stop,
    })
}

// ---------- the file system ----------

/// Top-level folder names and the spaces they stand for, with when they were read.
type SpaceNames = Option<(Instant, Vec<(String, SpaceId)>)>;

#[derive(Clone)]
struct DriveFs {
    engine: Engine,
    /// Top-level folder names, one per space, refreshed every few seconds.
    spaces: Arc<Mutex<SpaceNames>>,
}

/// Runs `op` on the engine unless the app is locked.
async fn on_engine<T, F>(engine: &Engine, op: F) -> FsResult<T>
where
    T: Send + 'static,
    F: for<'a> FnOnce(&'a mut Inner) -> LocalFut<'a, T> + Send + 'static,
{
    let res = engine
        .run(move |i| {
            Box::pin(async move {
                if i.is_locked() {
                    return Err("locked".to_string());
                }
                op(i).await
            })
        })
        .await;
    res.map_err(|e| {
        if e == "locked" {
            FsError::Forbidden
        } else if e.contains("200 MB") {
            FsError::TooLarge
        } else {
            eprintln!("anarchy drive share: {e}");
            FsError::GeneralFailure
        }
    })
}

/// Names that can't be folder or file names on Windows or macOS.
fn clean(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if "/\\:*?\"<>|".contains(c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { "Space".into() } else { s }
}

/// Clutter file managers write everywhere; refused so it never reaches the drive.
fn is_junk(name: &str) -> bool {
    name.starts_with("._")
        || matches!(
            name,
            ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".directory" | ".localized"
        )
        || name.starts_with(".~lock.")
}

fn segments(path: &DavPath) -> Vec<String> {
    String::from_utf8_lossy(path.as_bytes())
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Drive-relative folder of a path's parent (`/` or `/a/b`) and its name.
fn split_parent(rel: &[String]) -> (String, String) {
    let name = rel.last().cloned().unwrap_or_default();
    let folder = format!("/{}", rel[..rel.len().saturating_sub(1)].join("/"));
    (folder, name)
}

#[derive(Clone, Debug)]
struct Node {
    dir: bool,
    /// The file's record, or the folder's record if it has one.
    item: Option<DeskItem>,
    size: u64,
    modified: u64,
}

/// Paths (`/a`, `/a/b.txt`) to what's there, from the drive's records.
fn tree(items: &[DeskItem]) -> BTreeMap<String, Node> {
    let mut out: BTreeMap<String, Node> = BTreeMap::new();
    let dir = |item: Option<DeskItem>, modified| Node {
        dir: true,
        item,
        size: 0,
        modified,
    };
    for it in items.iter().filter(|x| x.data["deleted"] != json!(true)) {
        match it.kind.as_str() {
            "folder" => {
                if let Some(p) = it.data["path"].as_str() {
                    let p = norm(p);
                    add_parents(&mut out, &p, it.updated_ms);
                    out.insert(p, dir(Some(it.clone()), it.updated_ms));
                }
            }
            "file" => {
                let folder = norm(it.data["folder"].as_str().unwrap_or("/"));
                let name = it.data["name"].as_str().unwrap_or("file");
                let path = if folder == "/" {
                    format!("/{name}")
                } else {
                    format!("{folder}/{name}")
                };
                let size = it.data["file_key"]["size"].as_u64().unwrap_or(0);
                let modified = it.data["added"]
                    .as_u64()
                    .unwrap_or(it.updated_ms)
                    .max(it.updated_ms);
                if out.get(&path).is_some_and(|n| n.dir || n.modified > modified) {
                    continue;
                }
                add_parents(&mut out, &path, modified);
                out.insert(
                    path,
                    Node {
                        dir: false,
                        item: Some(it.clone()),
                        size,
                        modified,
                    },
                );
            }
            _ => {}
        }
    }
    out
}

fn norm(p: &str) -> String {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    format!("/{}", parts.join("/"))
}

fn add_parents(out: &mut BTreeMap<String, Node>, path: &str, modified: u64) {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    for k in 1..parts.len() {
        let p = format!("/{}", parts[..k].join("/"));
        out.entry(p).or_insert(Node {
            dir: true,
            item: None,
            size: 0,
            modified,
        });
    }
}

fn under(path: &str, dir: &str) -> Option<String> {
    path.strip_prefix(dir)
        .filter(|rest| rest.starts_with('/'))
        .map(str::to_owned)
}

struct Drive {
    channel: ChannelId,
    tree: BTreeMap<String, Node>,
}

impl DriveFs {
    fn new(engine: Engine) -> Self {
        Self {
            engine,
            spaces: Arc::new(Mutex::new(None)),
        }
    }

    async fn spaces(&self) -> FsResult<Vec<(String, SpaceId)>> {
        if let Ok(guard) = self.spaces.lock()
            && let Some((at, list)) = guard.as_ref()
            && at.elapsed() < Duration::from_secs(15)
        {
            return Ok(list.clone());
        }
        let list = on_engine(&self.engine, |i| Box::pin(ops::spaces(i))).await?;
        // Your own files come first; the nil id stands for them (see `drive`).
        let mut named: Vec<(String, SpaceId)> = vec![("My files".to_owned(), SpaceId::nil())];
        for s in list {
            let base = clean(&s.name);
            let mut name = base.clone();
            let mut n = 2;
            while named.iter().any(|(x, _)| x.eq_ignore_ascii_case(&name)) {
                name = format!("{base} ({n})");
                n += 1;
            }
            named.push((name, s.id));
        }
        if let Ok(mut guard) = self.spaces.lock() {
            *guard = Some((Instant::now(), named.clone()));
        }
        Ok(named)
    }

    async fn space(&self, name: &str) -> FsResult<SpaceId> {
        self.spaces()
            .await?
            .into_iter()
            .find(|(n, _)| n == name)
            .map(|(_, id)| id)
            .ok_or(FsError::NotFound)
    }

    /// The space's drive (made on first use) and what's in it.
    async fn drive(&self, space: SpaceId) -> FsResult<Drive> {
        let (channel, items) = on_engine(&self.engine, move |i| {
            Box::pin(async move {
                let channel = if space.is_nil() {
                    ops::ensure_personal(i, "files".into()).await?
                } else {
                    ops::ensure_drive(i, space).await?
                };
                let items = ops::desk_items(i, channel).await?;
                Ok((channel, items))
            })
        })
        .await?;
        Ok(Drive {
            channel,
            tree: tree(&items),
        })
    }

    async fn put(&self, channel: ChannelId, items: Vec<ItemRecord>) -> FsResult<()> {
        on_engine(&self.engine, move |i| Box::pin(ops::put_items(i, channel, items))).await
    }

    async fn download(&self, channel: ChannelId, data: Value) -> FsResult<Vec<u8>> {
        on_engine(&self.engine, move |i| {
            Box::pin(async move {
                i.client()?
                    .download_file(channel, &data)
                    .await
                    .map_err(|e| e.to_string())
            })
        })
        .await
    }

    /// Resolves a path to (space, drive-relative segments).
    async fn locate(&self, path: &DavPath) -> FsResult<Option<(SpaceId, Vec<String>)>> {
        let segs = segments(path);
        let Some(first) = segs.first() else {
            return Ok(None);
        };
        let space = self.space(first).await?;
        Ok(Some((space, segs[1..].to_vec())))
    }
}

fn record(item: &DeskItem, data: Value) -> ItemRecord {
    ItemRecord {
        id: item.id.clone(),
        kind: item.kind.clone(),
        data,
    }
}

fn deleted(item: &DeskItem) -> ItemRecord {
    let mut data = item.data.clone();
    data["deleted"] = json!(true);
    record(item, data)
}

impl DavFileSystem for DriveFs {
    fn open<'a>(&'a self, path: &'a DavPath, options: OpenOptions) -> FsFuture<'a, Box<dyn DavFile>> {
        async move {
            let (space, rel) = self.locate(path).await?.ok_or(FsError::Forbidden)?;
            if rel.is_empty() {
                return Err(FsError::Forbidden);
            }
            let (folder, name) = split_parent(&rel);
            let drive = self.drive(space).await?;
            let key = format!("/{}", rel.join("/"));
            let existing = drive.tree.get(&key).cloned();
            if existing.as_ref().is_some_and(|n| n.dir) {
                return Err(FsError::Forbidden);
            }
            if folder != "/" && !drive.tree.get(&folder).is_some_and(|n| n.dir) {
                return Err(FsError::NotFound);
            }
            let writing = options.write || options.append || options.create || options.create_new;
            if writing && is_junk(&name) {
                return Err(FsError::Forbidden);
            }
            match &existing {
                Some(_) if options.create_new => return Err(FsError::Exists),
                None if !(options.create || options.create_new) => return Err(FsError::NotFound),
                _ => {}
            }
            if let Some(size) = options.size
                && size > ops::MAX_FILE
            {
                return Err(FsError::TooLarge);
            }
            let item = existing.as_ref().and_then(|n| n.item.clone());
            let buf = match &item {
                Some(it) if !options.truncate => self.download(drive.channel, it.data.clone()).await?,
                _ => Vec::new(),
            };
            let pos = if options.append { buf.len() } else { 0 };
            let file = OpenFile {
                fs: self.clone(),
                channel: drive.channel,
                folder,
                name,
                id: item.map(|i| i.id),
                modified: existing.map(|n| n.modified).unwrap_or_else(now_ms),
                // A new or truncated file exists once it's opened for writing.
                dirty: writing && (options.truncate || item_missing(&key, &drive.tree)),
                buf,
                pos,
            };
            Ok(Box::new(file) as Box<dyn DavFile>)
        }
        .boxed()
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        async move {
            let entries: Vec<Box<dyn DavDirEntry>> = match self.locate(path).await? {
                None => self
                    .spaces()
                    .await?
                    .into_iter()
                    .map(|(name, _)| {
                        Box::new(Entry {
                            name,
                            meta: Meta::dir(now_ms()),
                        }) as Box<dyn DavDirEntry>
                    })
                    .collect(),
                Some((space, rel)) => {
                    let drive = self.drive(space).await?;
                    let here = format!("/{}", rel.join("/"));
                    if here != "/" && !drive.tree.get(&here).is_some_and(|n| n.dir) {
                        return Err(FsError::NotFound);
                    }
                    let prefix = if here == "/" { String::new() } else { here };
                    drive
                        .tree
                        .iter()
                        .filter_map(|(p, n)| {
                            let rest = under(p, &prefix)?;
                            let name = rest.trim_start_matches('/');
                            (!name.contains('/')).then(|| {
                                Box::new(Entry {
                                    name: name.to_owned(),
                                    meta: Meta::of(n),
                                }) as Box<dyn DavDirEntry>
                            })
                        })
                        .collect()
                }
            };
            Ok(futures_util::stream::iter(entries.into_iter().map(Ok)).boxed())
        }
        .boxed()
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        async move {
            let Some((space, rel)) = self.locate(path).await? else {
                return Ok(Box::new(Meta::dir(now_ms())) as Box<dyn DavMetaData>);
            };
            if rel.is_empty() {
                return Ok(Box::new(Meta::dir(now_ms())) as Box<dyn DavMetaData>);
            }
            let drive = self.drive(space).await?;
            let node = drive
                .tree
                .get(&format!("/{}", rel.join("/")))
                .ok_or(FsError::NotFound)?;
            Ok(Box::new(Meta::of(node)) as Box<dyn DavMetaData>)
        }
        .boxed()
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let (space, rel) = self.locate(path).await?.ok_or(FsError::Forbidden)?;
            if rel.is_empty() {
                return Err(FsError::Exists);
            }
            let drive = self.drive(space).await?;
            let key = format!("/{}", rel.join("/"));
            if drive.tree.contains_key(&key) {
                return Err(FsError::Exists);
            }
            let (parent, _) = split_parent(&rel);
            if parent != "/" && !drive.tree.get(&parent).is_some_and(|n| n.dir) {
                return Err(FsError::NotFound);
            }
            let rec = ItemRecord {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "folder".into(),
                data: json!({ "path": key }),
            };
            self.put(drive.channel, vec![rec]).await
        }
        .boxed()
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let (space, rel) = self.locate(path).await?.ok_or(FsError::Forbidden)?;
            if rel.is_empty() {
                return Err(FsError::Forbidden);
            }
            let drive = self.drive(space).await?;
            let key = format!("/{}", rel.join("/"));
            let node = drive.tree.get(&key).ok_or(FsError::NotFound)?;
            if !node.dir {
                return Err(FsError::Forbidden);
            }
            // Deletes the folder and everything left under it.
            let recs: Vec<ItemRecord> = drive
                .tree
                .iter()
                .filter(|(p, _)| **p == key || under(p, &key).is_some())
                .filter_map(|(_, n)| n.item.as_ref().map(deleted))
                .collect();
            self.put(drive.channel, recs).await
        }
        .boxed()
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let (space, rel) = self.locate(path).await?.ok_or(FsError::Forbidden)?;
            let drive = self.drive(space).await?;
            let node = drive
                .tree
                .get(&format!("/{}", rel.join("/")))
                .ok_or(FsError::NotFound)?;
            let item = node
                .item
                .as_ref()
                .filter(|_| !node.dir)
                .ok_or(FsError::Forbidden)?;
            self.put(drive.channel, vec![deleted(item)]).await
        }
        .boxed()
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let (space, src) = self.locate(from).await?.ok_or(FsError::Forbidden)?;
            let (to_space, dst) = self.locate(to).await?.ok_or(FsError::Forbidden)?;
            if src.is_empty() || dst.is_empty() {
                return Err(FsError::Forbidden);
            }
            if to_space != space {
                // Another space is another key: move a file by copying it over.
                self.copy(from, to).await?;
                return self.remove_file(from).await;
            }
            let drive = self.drive(space).await?;
            let from_key = format!("/{}", src.join("/"));
            let to_key = format!("/{}", dst.join("/"));
            let node = drive.tree.get(&from_key).ok_or(FsError::NotFound)?.clone();
            let (to_folder, to_name) = split_parent(&dst);
            if to_folder != "/" && !drive.tree.get(&to_folder).is_some_and(|n| n.dir) {
                return Err(FsError::NotFound);
            }
            let mut recs = Vec::new();
            // Whatever the move replaces goes (the handler already honoured Overwrite).
            if let Some(old) = drive.tree.get(&to_key).and_then(|n| n.item.as_ref())
                && to_key != from_key
            {
                recs.push(deleted(old));
            }
            if !node.dir {
                let item = node.item.as_ref().ok_or(FsError::NotFound)?;
                let mut data = item.data.clone();
                data["name"] = json!(to_name);
                data["folder"] = json!(to_folder);
                recs.push(record(item, data));
            } else {
                recs.push(ItemRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    kind: "folder".into(),
                    data: json!({ "path": to_key }),
                });
                for (p, n) in &drive.tree {
                    let Some(item) = &n.item else { continue };
                    let moved = if *p == from_key {
                        Some(String::new())
                    } else {
                        under(p, &from_key)
                    };
                    let Some(rest) = moved else { continue };
                    let mut data = item.data.clone();
                    if n.dir {
                        if rest.is_empty() {
                            recs.push(deleted(item));
                            continue;
                        }
                        data["path"] = json!(format!("{to_key}{rest}"));
                    } else {
                        let old_folder = norm(item.data["folder"].as_str().unwrap_or("/"));
                        let tail = old_folder.strip_prefix(&from_key).unwrap_or("");
                        data["folder"] = json!(format!("{to_key}{tail}"));
                    }
                    recs.push(record(item, data));
                }
            }
            self.put(drive.channel, recs).await
        }
        .boxed()
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let (space, src) = self.locate(from).await?.ok_or(FsError::Forbidden)?;
            let (to_space, dst) = self.locate(to).await?.ok_or(FsError::Forbidden)?;
            if dst.is_empty() {
                return Err(FsError::Forbidden);
            }
            let drive = self.drive(space).await?;
            let node = drive
                .tree
                .get(&format!("/{}", src.join("/")))
                .ok_or(FsError::NotFound)?;
            let item = node
                .item
                .clone()
                .filter(|_| !node.dir)
                .ok_or(FsError::Forbidden)?;
            let (to_folder, to_name) = split_parent(&dst);
            let to_key = format!("/{}", dst.join("/"));
            let from_channel = drive.channel;
            let target = if to_space == space {
                drive
            } else {
                self.drive(to_space).await?
            };
            if to_folder != "/" && !target.tree.get(&to_folder).is_some_and(|n| n.dir) {
                return Err(FsError::NotFound);
            }
            let replaces = target
                .tree
                .get(&to_key)
                .and_then(|n| n.item.as_ref())
                .map(|i| i.id.clone());
            if to_space == space {
                // Same space, same key: the copy points at the same encrypted chunks.
                let mut data = item.data.clone();
                data["name"] = json!(to_name);
                data["folder"] = json!(to_folder);
                data["added"] = json!(now_ms());
                let id = replaces.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                return self
                    .put(
                        target.channel,
                        vec![ItemRecord {
                            id,
                            kind: "file".into(),
                            data,
                        }],
                    )
                    .await;
            }
            // Another space has another key: decrypt here and upload again.
            let bytes = self.download(from_channel, item.data.clone()).await?;
            let channel = target.channel;
            on_engine(&self.engine, move |i| {
                Box::pin(async move {
                    ops::store_file(i, channel, &bytes, &to_name, &to_folder, replaces).await?;
                    Ok(())
                })
            })
            .await
        }
        .boxed()
    }
}

fn item_missing(key: &str, tree: &BTreeMap<String, Node>) -> bool {
    !tree.contains_key(key)
}

// ---------- open files ----------

struct OpenFile {
    fs: DriveFs,
    channel: ChannelId,
    folder: String,
    name: String,
    /// The record this file replaces when it's written.
    id: Option<String>,
    modified: u64,
    dirty: bool,
    buf: Vec<u8>,
    pos: usize,
}

impl std::fmt::Debug for OpenFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenFile")
            .field("folder", &self.folder)
            .field("name", &self.name)
            .field("len", &self.buf.len())
            .finish()
    }
}

impl OpenFile {
    fn write_at(&mut self, data: &[u8]) -> FsResult<()> {
        let end = self.pos + data.len();
        if end as u64 > ops::MAX_FILE {
            return Err(FsError::TooLarge);
        }
        if self.buf.len() < end {
            self.buf.resize(end, 0);
        }
        self.buf[self.pos..end].copy_from_slice(data);
        self.pos = end;
        self.dirty = true;
        Ok(())
    }
}

impl DavFile for OpenFile {
    fn metadata(&'_ mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = Meta {
            len: self.buf.len() as u64,
            modified: self.modified,
            dir: false,
        };
        async move { Ok(Box::new(meta) as Box<dyn DavMetaData>) }.boxed()
    }

    fn write_buf(&'_ mut self, mut buf: Box<dyn bytes::Buf + Send>) -> FsFuture<'_, ()> {
        async move {
            while buf.has_remaining() {
                let chunk = buf.chunk().to_vec();
                buf.advance(chunk.len());
                self.write_at(&chunk)?;
            }
            Ok(())
        }
        .boxed()
    }

    fn write_bytes(&'_ mut self, buf: Bytes) -> FsFuture<'_, ()> {
        async move { self.write_at(&buf) }.boxed()
    }

    fn read_bytes(&'_ mut self, count: usize) -> FsFuture<'_, Bytes> {
        async move {
            let start = self.pos.min(self.buf.len());
            let end = (start + count).min(self.buf.len());
            self.pos = end;
            Ok(Bytes::copy_from_slice(&self.buf[start..end]))
        }
        .boxed()
    }

    fn seek(&'_ mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        async move {
            let len = self.buf.len() as i64;
            let at = match pos {
                SeekFrom::Start(n) => n as i64,
                SeekFrom::End(n) => len + n,
                SeekFrom::Current(n) => self.pos as i64 + n,
            };
            if at < 0 {
                return Err(FsError::GeneralFailure);
            }
            self.pos = at as usize;
            Ok(at as u64)
        }
        .boxed()
    }

    fn flush(&'_ mut self) -> FsFuture<'_, ()> {
        async move {
            if !self.dirty {
                return Ok(());
            }
            let (channel, folder, name, id) = (
                self.channel,
                self.folder.clone(),
                self.name.clone(),
                self.id.clone(),
            );
            let bytes = std::mem::take(&mut self.buf);
            let res = on_engine(&self.fs.engine, move |i| {
                Box::pin(async move {
                    let id = ops::store_file(i, channel, &bytes, &name, &folder, id).await?;
                    Ok((id, bytes))
                })
            })
            .await;
            let (id, bytes) = res?;
            self.buf = bytes;
            self.id = Some(id);
            self.dirty = false;
            self.modified = now_ms();
            Ok(())
        }
        .boxed()
    }
}

// ---------- metadata ----------

#[derive(Clone, Debug)]
struct Meta {
    len: u64,
    modified: u64,
    dir: bool,
}

impl Meta {
    fn dir(modified: u64) -> Self {
        Self {
            len: 0,
            modified,
            dir: true,
        }
    }
    fn of(n: &Node) -> Self {
        Self {
            len: n.size,
            modified: n.modified,
            dir: n.dir,
        }
    }
}

impl DavMetaData for Meta {
    fn len(&self) -> u64 {
        self.len
    }
    fn modified(&self) -> FsResult<SystemTime> {
        Ok(UNIX_EPOCH + Duration::from_millis(self.modified))
    }
    fn is_dir(&self) -> bool {
        self.dir
    }
}

struct Entry {
    name: String,
    meta: Meta,
}

impl DavDirEntry for Entry {
    fn name(&self) -> Vec<u8> {
        self.name.as_bytes().to_vec()
    }
    fn metadata(&'_ self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = self.meta.clone();
        async move { Ok(Box::new(meta) as Box<dyn DavMetaData>) }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str, data: Value, t: u64) -> DeskItem {
        DeskItem {
            id: id.into(),
            kind: kind.into(),
            data,
            seq: t,
            updated_ms: t,
        }
    }

    #[test]
    fn tree_from_records() {
        let items = vec![
            item("a", "folder", json!({"path": "/Empty"}), 1),
            item(
                "b",
                "file",
                json!({"name": "q.pdf", "folder": "/Clients/Roux", "file_key": {"size": 5}}),
                2,
            ),
            item(
                "c",
                "file",
                json!({"name": "gone.txt", "folder": "/", "deleted": true}),
                3,
            ),
        ];
        let t = tree(&items);
        let keys: Vec<&str> = t.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["/Clients", "/Clients/Roux", "/Clients/Roux/q.pdf", "/Empty"]
        );
        assert!(t["/Clients"].dir && t["/Clients"].item.is_none());
        assert_eq!(t["/Clients/Roux/q.pdf"].size, 5);
    }

    #[test]
    fn names() {
        assert_eq!(clean("R&D: 2026/Q3"), "R&D- 2026-Q3");
        assert_eq!(clean(" ..."), "Space");
        assert!(is_junk("._x.pdf") && is_junk(".DS_Store") && !is_junk("x.pdf"));
        assert_eq!(under("/a/b", "/a").as_deref(), Some("/b"));
        assert_eq!(under("/ab", "/a"), None);
    }
}
