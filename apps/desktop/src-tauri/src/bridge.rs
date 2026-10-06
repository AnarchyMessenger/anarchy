//! The agent bridge (D43): agents on this computer read what you keep in
//! Anarchy through MCP, the protocol Claude Code, Codex, Cursor and Backspace
//! already speak.
//!
//! - Off until you turn it on (Settings → Agents on this computer → Let agents on this
//!   computer read Anarchy).
//! - Listens on 127.0.0.1 only, behind a bearer token; other Host headers are
//!   refused, so a web page can't reach it by DNS rebinding.
//! - Sees your personal desks and Company channels, never a Sealed
//!   conversation with other people (`ops::agent_call`).
//! - Reads; adds and updates tasks (D46); drafts into the composer. It never
//!   sends a message itself, and never deletes.
//! - Every call is listed in Settings, newest first.
//!
//! Clients that speak MCP over HTTP use the URL and token directly. Clients
//! that only start programs get `anarchy-desktop --mcp`, a stdio shim that
//! finds the running app through `bridge.json` in the data folder.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::engine::Engine;
use anarchy_proto::ChannelId;

/// Saved in the device's settings as `bridge`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BridgePrefs {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl BridgePrefs {
    pub fn new_token() -> String {
        let mut b = [0u8; 32];
        getrandom::fill(&mut b).expect("OS random number generator unavailable");
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}

/// One call, for the list in Settings.
#[derive(Debug, Clone, Serialize)]
pub struct Call {
    pub at_ms: u64,
    pub tool: String,
    pub ok: bool,
    /// What it asked, briefly: the query, the desk, where a draft went.
    pub about: String,
}

pub type Log = Arc<Mutex<VecDeque<Call>>>;
pub type OnDraft = Arc<dyn Fn(ChannelId, String) + Send + Sync>;

pub struct Running {
    pub port: u16,
    pub token: String,
    pub log: Log,
    file: PathBuf,
    _stop: oneshot::Sender<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.file);
    }
}

/// Where a running app says how to reach it, for `--mcp`.
pub fn bridge_file(data_dir: &Path) -> PathBuf {
    data_dir.join("bridge.json")
}

/// Starts the bridge; tries the saved port first so agents' settings keep working.
pub async fn start(
    engine: Engine,
    prefs: &BridgePrefs,
    data_dir: &Path,
    on_draft: OnDraft,
) -> Result<Running, String> {
    let listener = match TcpListener::bind(("127.0.0.1", prefs.port)).await {
        Ok(l) if prefs.port != 0 => l,
        _ => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Can't open the agent bridge: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let file = bridge_file(data_dir);
    write_private(
        &file,
        &json!({ "url": format!("http://127.0.0.1:{port}/mcp"), "token": prefs.token }),
    )?;
    let log: Log = Arc::new(Mutex::new(VecDeque::new()));
    let (stop, mut stopped) = oneshot::channel::<()>();
    let ctx = Arc::new(Ctx {
        engine,
        token: prefs.token.clone(),
        port,
        log: log.clone(),
        on_draft,
        recent: Mutex::new(VecDeque::new()),
    });
    tokio::spawn(async move {
        loop {
            let stream = tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => stream,
                    Err(_) => continue,
                },
            };
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let ctx = ctx.clone();
                    async move { Ok::<_, std::convert::Infallible>(ctx.handle(req).await) }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(Running {
        port,
        token: prefs.token.clone(),
        log,
        file,
        _stop: stop,
    })
}

struct Ctx {
    engine: Engine,
    token: String,
    port: u16,
    log: Log,
    on_draft: OnDraft,
    /// When the last requests came, for the rate limit.
    recent: Mutex<VecDeque<std::time::Instant>>,
}

const MAX_BODY: usize = 256 * 1024;
const RATE_PER_MINUTE: usize = 60;

impl Ctx {
    async fn handle(&self, req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
        let host_ok = req
            .headers()
            .get(hyper::header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| {
                h == format!("127.0.0.1:{}", self.port) || h == format!("localhost:{}", self.port)
            });
        // Browsers send an Origin; agents don't. No page gets in, even with the token.
        let from_page = req.headers().contains_key(hyper::header::ORIGIN);
        if !host_ok || from_page {
            return plain(StatusCode::FORBIDDEN, "forbidden");
        }
        let authorized = req
            .headers()
            .get(hyper::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .is_some_and(|t| same(t.as_bytes(), self.token.as_bytes()));
        if !authorized {
            return plain(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        if !self.allow() {
            return Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(hyper::header::RETRY_AFTER, "60")
                .body(Full::new(Bytes::from_static(
                    b"too many requests; at most 60 a minute",
                )))
                .unwrap();
        }
        if req.method() != hyper::Method::POST || req.uri().path() != "/mcp" {
            return plain(StatusCode::NOT_FOUND, "POST /mcp");
        }
        // Capped while reading, so a huge body is never held in memory.
        let body = match http_body_util::Limited::new(req.into_body(), MAX_BODY)
            .collect()
            .await
        {
            Ok(b) => b.to_bytes(),
            Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
        };
        let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
            return rpc(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }),
            );
        };
        match self.answer(&msg).await {
            Some(out) => rpc(out),
            // A notification: nothing to say back.
            None => Response::builder()
                .status(StatusCode::ACCEPTED)
                .body(Full::new(Bytes::new()))
                .unwrap(),
        }
    }

    /// One JSON-RPC message in, its answer out (`None` for notifications).
    async fn answer(&self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned()?;
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
        Some(match method {
            "initialize" => ok(json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "anarchy", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Anarchy is this person's task list, agenda, notes and desks. Call anarchy_get_context first. When they mention something they need to do, add it with anarchy_create_tasks (give it an external_id); move tasks along with anarchy_update_task as work happens; search before adding what may already exist. You can draft messages for them to send, but not send them, and private Sealed conversations are never shared.",
            })),
            "ping" => ok(json!({})),
            "tools/list" => ok(json!({ "tools": crate::ops::agent_tools() })),
            "tools/call" => {
                let tool = msg["params"]["name"].as_str().unwrap_or("").to_owned();
                let args = msg["params"]["arguments"].clone();
                let about = about(&tool, &args);
                let t = tool.clone();
                let answer = self
                    .engine
                    .run(move |i| Box::pin(async move { crate::ops::agent_call(i, &t, &args).await }))
                    .await;
                self.record(&tool, answer.is_ok(), about);
                match answer {
                    Ok(a) => {
                        if let Some((channel, text)) = a.draft {
                            (self.on_draft)(channel, text);
                        }
                        ok(
                            json!({ "content": [{ "type": "text", "text": a.result.to_string() }], "structuredContent": a.result }),
                        )
                    }
                    Err(e) => ok(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
                }
            }
            _ => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("no method {method}") } })
            }
        })
    }

    /// 60 requests a minute, like Roma's: plenty for an agent, not a firehose.
    fn allow(&self) -> bool {
        let now = std::time::Instant::now();
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        while recent
            .front()
            .is_some_and(|t| now.duration_since(*t).as_secs() >= 60)
        {
            recent.pop_front();
        }
        if recent.len() >= RATE_PER_MINUTE {
            return false;
        }
        recent.push_back(now);
        true
    }

    fn record(&self, tool: &str, ok: bool, about: String) {
        let mut log = self.log.lock().unwrap_or_else(|e| e.into_inner());
        log.push_front(Call {
            at_ms: crate::engine::now_ms(),
            tool: tool.to_owned(),
            ok,
            about,
        });
        log.truncate(50);
    }
}

fn about(tool: &str, args: &Value) -> String {
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(60)
            .collect::<String>()
    };
    match tool {
        "anarchy_search" => format!("\u{201c}{}\u{201d}", s("query")),
        "anarchy_desk_items" => s("desk"),
        "anarchy_draft" => format!("for {}", s("to")),
        "anarchy_today" => s("date"),
        "anarchy_create_tasks" => {
            let n = args
                .get("tasks")
                .and_then(|t| t.as_array())
                .map_or(0, |t| t.len());
            format!("{n} {}", if n == 1 { "task" } else { "tasks" })
        }
        "anarchy_update_task" => args
            .get("status")
            .and_then(|v| v.as_str())
            .map(|st| format!("to {st}"))
            .unwrap_or_default(),
        "anarchy_list_tasks" => s("desk"),
        _ => String::new(),
    }
}

/// Compares in constant time, so the token can't be guessed byte by byte.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::from_static(text.as_bytes())))
        .unwrap()
}

fn rpc(v: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(v.to_string())))
        .unwrap()
}

/// Writes a file only this user can read (it holds the token).
fn write_private(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    let mut f = opts.open(path).map_err(|e| e.to_string())?;
    f.write_all(v.to_string().as_bytes()).map_err(|e| e.to_string())
}

// ---------- `anarchy-desktop --mcp`: the stdio shim ----------

/// The app's data folder, the way Tauri picks it, without starting Tauri.
/// `ANARCHY_DATA_DIR` overrides it.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("ANARCHY_DATA_DIR") {
        return Some(PathBuf::from(d));
    }
    const ID: &str = "org.anarchymessenger.desktop";
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        home?.join("Library/Application Support")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".local/share")))?
    };
    Some(base.join(ID))
}

/// Reads JSON-RPC lines on stdin, forwards each to the running app, writes the
/// answers on stdout. Errors go back as JSON-RPC errors, so the agent can say why.
pub fn stdio_shim() {
    use std::io::{BufRead, Write};
    let target = data_dir()
        .map(|d| bridge_file(&d))
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let id = serde_json::from_str::<Value>(&line)
            .ok()
            .and_then(|m| m.get("id").cloned());
        let reply = match &target {
            Some(t) => post(
                t["url"].as_str().unwrap_or(""),
                t["token"].as_str().unwrap_or(""),
                &line,
            ),
            None => Err(
                "Anarchy isn't running, or its agent bridge is off (Settings → Agents on this computer)"
                    .to_string(),
            ),
        };
        let text = match (reply, &id) {
            (Ok(body), _) if !body.trim().is_empty() => body,
            (Ok(_), _) => continue,
            (Err(_), None) => continue,
            (Err(e), Some(id)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": e } }).to_string()
            }
        };
        if writeln!(out, "{}", text.trim())
            .and_then(|_| out.flush())
            .is_err()
        {
            break;
        }
    }
}

/// A plain HTTP/1.1 POST to the local bridge; no TLS, no proxies, loopback only.
fn post(url: &str, token: &str, body: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .ok_or("bad bridge address")?;
    let (port, path) = rest.split_once('/').ok_or("bad bridge address")?;
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().map_err(|_| "bad port")?))
        .map_err(|_| {
            "Anarchy isn't running, or its agent bridge is off (Settings → Agents on this computer)"
                .to_string()
        })?;
    write!(
        s,
        "POST /{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&raw);
    let (head, body) = raw.split_once("\r\n\r\n").ok_or("bad answer from Anarchy")?;
    let status = head.split_whitespace().nth(1).unwrap_or("");
    match status {
        "200" | "202" => Ok(body.to_owned()),
        "401" => Err("The agent bridge's token changed; restart this agent".into()),
        other => Err(format!("Anarchy answered {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::Engine;
    use anarchy_core::ItemRecord;

    fn raw(port: u16, head: &str, body: &str) -> (String, String) {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "POST /mcp HTTP/1.1\r\n{head}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let (h, b) = out.split_once("\r\n\r\n").unwrap();
        (h.split_whitespace().nth(1).unwrap().to_owned(), b.to_owned())
    }

    fn call(url: &str, token: &str, id: u32, tool: &str, args: Value) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        let out: Value = serde_json::from_str(&post(url, token, &body.to_string()).unwrap()).unwrap();
        out["result"].clone()
    }

    async fn engine_with_local_account() -> (Engine, PathBuf) {
        let dir = std::env::temp_dir().join(format!("anarchy-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Engine::start(dir.clone(), Box::new(|_, _| {}));
        engine
            .run(|i| Box::pin(crate::ops::start_local(i, "Maya Chen".into())))
            .await
            .unwrap();
        (engine, dir)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn agents_read_your_desks_and_only_draft() {
        let (engine, dir) = engine_with_local_account().await;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let t = today.clone();
        engine
            .run(move |i| {
                Box::pin(async move {
                    let tasks = crate::ops::ensure_personal(i, "tasks".into()).await?;
                    let agenda = crate::ops::ensure_personal(i, "agenda".into()).await?;
                    crate::ops::put_items(i, tasks, vec![
                        ItemRecord { id: "c1".into(), kind: "card".into(), data: json!({ "title": "Send the Acme invoice", "column": "todo", "due": "2020-01-01" }) },
                        ItemRecord { id: "c2".into(), kind: "card".into(), data: json!({ "title": "Done already", "column": "done", "due": "2020-01-01" }) },
                        ItemRecord { id: "c3".into(), kind: "card".into(), data: json!({ "title": "Some day", "column": "todo", "due": "2999-01-01", "file_key": "SECRET" }) },
                    ]).await?;
                    crate::ops::put_items(i, agenda, vec![ItemRecord { id: "e1".into(), kind: "event".into(), data: json!({ "title": "Call with Tomás", "date": t, "start": "10:00" }) }]).await
                })
            })
            .await
            .unwrap();

        let drafts: Arc<Mutex<Vec<(ChannelId, String)>>> = Default::default();
        let d = drafts.clone();
        let prefs = BridgePrefs {
            enabled: true,
            port: 0,
            token: BridgePrefs::new_token(),
        };
        let running = start(
            engine.clone(),
            &prefs,
            &dir,
            Arc::new(move |c, t| d.lock().unwrap().push((c, t))),
        )
        .await
        .unwrap();
        let (port, token) = (running.port, prefs.token.clone());
        // The shim finds the app through this file; only this user may read it.
        let file: Value = serde_json::from_slice(&std::fs::read(bridge_file(&dir)).unwrap()).unwrap();
        assert_eq!(file["token"], json!(token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(bridge_file(&dir)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let url = file["url"].as_str().unwrap().to_owned();

        tokio::task::spawn_blocking(move || {
            let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;
            // No token, a wrong one, a web page, another host name: all refused.
            assert_eq!(raw(port, &format!("Host: 127.0.0.1:{port}\r\n"), init).0, "401");
            assert_eq!(raw(port, &format!("Host: 127.0.0.1:{port}\r\nAuthorization: Bearer nope\r\n"), init).0, "401");
            assert_eq!(raw(port, &format!("Host: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nOrigin: https://evil.example\r\n"), init).0, "403");
            assert_eq!(raw(port, &format!("Host: evil.example:{port}\r\nAuthorization: Bearer {token}\r\n"), init).0, "403");

            let hello: Value = serde_json::from_str(&post(&url, &token, init).unwrap()).unwrap();
            assert_eq!(hello["result"]["serverInfo"]["name"], "anarchy");
            // Notifications get no answer.
            assert_eq!(post(&url, &token, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).unwrap(), "");
            let list: Value = serde_json::from_str(&post(&url, &token, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).unwrap()).unwrap();
            let tools = list["result"]["tools"].as_array().unwrap().clone();
            assert_eq!(tools.len(), 9);
            // Every tool says whether it reads or writes, so clients know what to ask about.
            assert!(tools.iter().all(|t| t["annotations"]["readOnlyHint"].is_boolean()));

            let day = call(&url, &token, 3, "anarchy_today", json!({}));
            let day = &day["structuredContent"];
            assert_eq!(day["events"][0]["title"], "Call with Tomás");
            let titles: Vec<_> = day["tasks"].as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_owned()).collect();
            assert_eq!(titles, ["Send the Acme invoice"]);
            assert_eq!(day["tasks"][0]["late"], true);

            let hits = call(&url, &token, 4, "anarchy_search", json!({ "query": "acme" }));
            assert_eq!(hits["structuredContent"]["results"].as_array().unwrap().len(), 1);

            // Keys never leave the device.
            let items = call(&url, &token, 5, "anarchy_desk_items", json!({ "desk": "tasks" }));
            assert!(!items.to_string().contains("SECRET"));
            assert_eq!(items["structuredContent"]["items"].as_array().unwrap().len(), 3);

            let drafted = call(&url, &token, 6, "anarchy_draft", json!({ "to": "tasks", "text": "Reminder: Acme" }));
            assert_eq!(drafted["structuredContent"]["sent"], false);
            let bad = call(&url, &token, 7, "anarchy_desk_items", json!({ "desk": "nowhere" }));
            assert_eq!(bad["isError"], true);

            // Tasks, the Roma way: orient, add (safely twice), move, and add notes.
            let ctx = call(&url, &token, 8, "anarchy_get_context", json!({}));
            let ctx = &ctx["structuredContent"];
            assert_eq!(ctx["user"]["name"], "Maya Chen");
            assert_eq!(ctx["tasks"]["late"][0]["title"], "Send the Acme invoice");
            assert_eq!(ctx["agenda_today"][0]["title"], "Call with Tomás");
            let batch = json!({ "tasks": [
                { "title": "Book the venue", "external_id": "chat-1", "notes": "Three options in SF" },
                { "title": "", "external_id": "chat-2" },
                { "title": "Order the cake", "status": "inProgress", "due": "2999-05-01" } ] });
            let made = call(&url, &token, 9, "anarchy_create_tasks", batch.clone());
            let made = &made["structuredContent"];
            assert_eq!(made["created"].as_array().unwrap().len(), 2);
            assert_eq!(made["failed"][0]["row"], 1, "one bad row doesn't fail the batch");
            let again = call(&url, &token, 10, "anarchy_create_tasks", json!({ "tasks": [batch["tasks"][0].clone()] }));
            assert_eq!(again["structuredContent"]["existing"].as_array().unwrap().len(), 1, "the same external_id isn't added twice");
            assert!(again["structuredContent"]["created"].as_array().unwrap().is_empty());
            let venue = made["created"][0]["id"].as_str().unwrap().to_owned();
            let moved = call(&url, &token, 11, "anarchy_update_task", json!({ "id": venue, "status": "inProgress", "notes": "Called the first one" }));
            assert_eq!(moved["structuredContent"]["status"], "inProgress");
            assert_eq!(moved["structuredContent"]["notes"], "Three options in SF\n\nCalled the first one", "notes append by default");
            let wipe = call(&url, &token, 12, "anarchy_update_task", json!({ "id": venue, "notes": "gone", "mode": "replace" }));
            assert_eq!(wipe["isError"], true, "replacing notes needs confirm_replace");
            let doing = call(&url, &token, 13, "anarchy_list_tasks", json!({ "status": ["inProgress"] }));
            let titles: Vec<_> = doing["structuredContent"]["tasks"].as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_owned()).collect();
            assert_eq!(titles, ["Order the cake", "Book the venue"], "by due date, undated last");
            let open = call(&url, &token, 14, "anarchy_list_tasks", json!({}));
            assert!(!open.to_string().contains("Done already"), "finished tasks are left out unless asked for");
        })
        .await
        .unwrap();

        assert_eq!(drafts.lock().unwrap().len(), 1);
        assert_eq!(drafts.lock().unwrap()[0].1, "Reminder: Acme");
        let log = running.log.lock().unwrap().clone();
        assert_eq!(log.len(), 12);
        assert_eq!(log[0].tool, "anarchy_list_tasks");
        assert!(
            log.iter().any(|c| c.tool == "anarchy_update_task" && !c.ok),
            "a refused write is logged as refused"
        );
        drop(running);
        assert!(
            !bridge_file(&dir).exists(),
            "the bridge file goes when the bridge stops"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// Needs the test Postgres (`ANARCHY_TEST_DATABASE_URL`); skipped without it.
    #[tokio::test(flavor = "multi_thread")]
    async fn sealed_conversations_never_reach_an_agent() {
        if std::env::var("ANARCHY_TEST_DATABASE_URL").is_err() {
            eprintln!("skipped: set ANARCHY_TEST_DATABASE_URL");
            return;
        }
        let server = anarchy_testkit::TestServer::start_with(anarchy_testkit::TestOptions {
            open: true,
            ..Default::default()
        })
        .await;
        let dir = std::env::temp_dir().join(format!("anarchy-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Engine::start(dir.clone(), Box::new(|_, _| {}));
        let url = server.url.clone();
        let (sealed, company) = engine
            .run(move |i| {
                Box::pin(async move {
                    crate::ops::sign_in_anonymous(i, url, "Maya".into()).await?;
                    let space =
                        crate::ops::create_space(i, "Studio".into(), anarchy_proto::SpaceKind::Freelance)
                            .await?
                            .id;
                    let sealed = crate::ops::create_channel(
                        i,
                        Some(space),
                        "board".into(),
                        String::new(),
                        anarchy_core::Trust::Sealed,
                    )
                    .await?;
                    let company = crate::ops::create_channel(
                        i,
                        Some(space),
                        "studio".into(),
                        String::new(),
                        anarchy_core::Trust::Company,
                    )
                    .await?;
                    crate::ops::send_message(i, sealed, "budget: the real numbers".into(), None).await?;
                    crate::ops::send_message(i, company, "budget review on Friday".into(), None).await?;
                    Ok::<_, String>((sealed, company))
                })
            })
            .await
            .unwrap();
        let hits = engine
            .run(|i| {
                Box::pin(async move {
                    crate::ops::agent_call(i, "anarchy_search", &json!({ "query": "budget" }))
                        .await
                        .map(|a| a.result)
                })
            })
            .await
            .unwrap();
        let text = hits.to_string();
        assert!(text.contains("budget review on Friday"), "{text}");
        assert!(
            !text.contains("real numbers"),
            "a Sealed message reached an agent: {text}"
        );
        // Nor can an agent draft into it by id.
        let id = sealed.to_string();
        let refused = engine
            .run(move |i| {
                Box::pin(async move {
                    crate::ops::agent_call(i, "anarchy_draft", &json!({ "to": id, "text": "hi" }))
                        .await
                        .map(|a| a.result)
                })
            })
            .await;
        assert!(refused.is_err());
        let id = company.to_string();
        assert!(
            engine
                .run(move |i| Box::pin(async move {
                    crate::ops::agent_call(i, "anarchy_draft", &json!({ "to": id, "text": "hi" }))
                        .await
                        .map(|a| a.result)
                }))
                .await
                .is_ok()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tokens_compare_in_full() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
        assert_eq!(BridgePrefs::new_token().len(), 64);
    }
}
