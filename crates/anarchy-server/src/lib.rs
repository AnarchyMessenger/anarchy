//! Anarchy server: gateway and delivery service.
//!
//! Phase 0 keeps state in memory behind [`Store`]; Postgres comes next without
//! changing the HTTP surface. The server stores ciphertext and metadata only.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anarchy_proto::{
    AppendRequest, AppendResponse, Blob, ChannelId, DeviceId, Event, EventKind, EventsPage, InboxItem,
    KeyPackageUpload,
};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
struct Channel {
    epoch: u64,
    events: Vec<Event>,
    seen: HashMap<Uuid, u64>,
}

/// In-memory state. Every field is either ciphertext or routing metadata.
#[derive(Default)]
pub struct Store {
    channels: HashMap<ChannelId, Channel>,
    key_packages: HashMap<DeviceId, VecDeque<Blob>>,
    inboxes: HashMap<DeviceId, Vec<InboxItem>>,
}

impl Store {
    /// Every payload stored for a channel, for tests that check the server holds no plaintext.
    pub fn payloads(&self, channel: ChannelId) -> Vec<Vec<u8>> {
        self.channels
            .get(&channel)
            .map(|c| c.events.iter().map(|e| e.payload.0.clone()).collect())
            .unwrap_or_default()
    }
}

pub type SharedStore = Arc<Mutex<Store>>;

pub fn router(store: SharedStore) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/channels/{channel}/events", post(append).get(events))
        .route("/v1/devices/{device}/key_packages", post(upload_key_packages))
        .route("/v1/devices/{device}/key_packages/claim", post(claim_key_package))
        .route("/v1/devices/{device}/inbox", post(push_inbox).get(drain_inbox))
        .with_state(store)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn append(
    State(store): State<SharedStore>,
    Path(channel): Path<ChannelId>,
    Json(req): Json<AppendRequest>,
) -> Json<AppendResponse> {
    let mut store = store.lock().await;
    let ch = store.channels.entry(channel).or_default();

    if let Some(&seq) = ch.seen.get(&req.idempotency_key) {
        return Json(AppendResponse::Accepted { seq });
    }
    // Commits must build on the current epoch; this is what orders concurrent
    // commits. Application messages from an older epoch are rejected too, so a
    // lagging sender catches up before its message lands after a membership change.
    if req.epoch != ch.epoch {
        return Json(AppendResponse::StaleEpoch {
            current_epoch: ch.epoch,
        });
    }

    let seq = ch.events.len() as u64 + 1;
    ch.events.push(Event {
        seq,
        epoch: req.epoch,
        kind: req.kind,
        sender_device: req.sender_device,
        ts_ms: now_ms(),
        payload: req.payload,
    });
    ch.seen.insert(req.idempotency_key, seq);
    if req.kind == EventKind::Commit {
        ch.epoch += 1;
    }
    Json(AppendResponse::Accepted { seq })
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after: u64,
}

async fn events(
    State(store): State<SharedStore>,
    Path(channel): Path<ChannelId>,
    Query(q): Query<EventsQuery>,
) -> Json<EventsPage> {
    let store = store.lock().await;
    let Some(ch) = store.channels.get(&channel) else {
        return Json(EventsPage {
            events: vec![],
            head: 0,
        });
    };
    let events = ch.events.iter().filter(|e| e.seq > q.after).cloned().collect();
    Json(EventsPage {
        events,
        head: ch.events.len() as u64,
    })
}

async fn upload_key_packages(
    State(store): State<SharedStore>,
    Path(device): Path<DeviceId>,
    Json(req): Json<KeyPackageUpload>,
) -> StatusCode {
    let mut store = store.lock().await;
    store
        .key_packages
        .entry(device)
        .or_default()
        .extend(req.key_packages);
    StatusCode::NO_CONTENT
}

/// Key packages are single-use in MLS, so claiming one removes it.
async fn claim_key_package(
    State(store): State<SharedStore>,
    Path(device): Path<DeviceId>,
) -> Result<Json<Blob>, StatusCode> {
    let mut store = store.lock().await;
    store
        .key_packages
        .get_mut(&device)
        .and_then(VecDeque::pop_front)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn push_inbox(
    State(store): State<SharedStore>,
    Path(device): Path<DeviceId>,
    Json(item): Json<InboxItem>,
) -> StatusCode {
    store.lock().await.inboxes.entry(device).or_default().push(item);
    StatusCode::NO_CONTENT
}

async fn drain_inbox(State(store): State<SharedStore>, Path(device): Path<DeviceId>) -> Json<Vec<InboxItem>> {
    Json(store.lock().await.inboxes.remove(&device).unwrap_or_default())
}
