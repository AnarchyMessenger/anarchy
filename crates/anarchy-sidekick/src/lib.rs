//! The sidekick host (D32).
//!
//! Each person who turns on a server-side sidekick gets an account of its own
//! (see `anarchy_server::sidekicks`). This host keeps one encrypted device per
//! sidekick and, on every [`Host::tick`]:
//!
//! - joins the channels its person added it to,
//! - reads what's new there and keeps it in the device's local history,
//! - forgets a channel, history included, when it's removed or its person
//!   leaves (the server stops serving it the moment they do),
//! - answers its person in their one-to-one conversation.
//!
//! No model is connected yet, so an answer is a search over the channels its
//! person let it read, never anything else. The host only ever sees what its
//! person chose to show it, but the operator of this host can read that: that's
//! why it's opt-in per channel and Sealed channels are refused by the app.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anarchy_core::{Client, Content, Device};
use anarchy_proto::{ChannelId, ChannelKind, DeviceId, UserId};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Core(#[from] anarchy_core::Error),
}

/// How many key packages a sidekick keeps on the server, one per channel it can still be added to.
const KEY_PACKAGES: usize = 4;

struct Agent {
    owner: UserId,
    client: Client,
    /// The one-to-one conversation with its person, once they started it.
    dm: Option<ChannelId>,
    names: HashMap<DeviceId, String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TickReport {
    pub joined: Vec<ChannelId>,
    pub forgot: Vec<ChannelId>,
    pub answered: usize,
}

pub struct Host {
    server: String,
    token: String,
    dir: PathBuf,
    key: [u8; 32],
    agents: HashMap<UserId, Agent>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl Host {
    /// `dir` holds one encrypted device file per sidekick, sealed with `key`.
    pub fn new(
        server: impl Into<String>,
        token: impl Into<String>,
        dir: impl Into<PathBuf>,
        key: [u8; 32],
    ) -> Self {
        Self {
            server: server.into(),
            token: token.into(),
            dir: dir.into(),
            key,
            agents: HashMap::new(),
        }
    }

    /// The device a sidekick runs on, once the host has started it.
    pub fn device_of(&self, agent: UserId) -> Option<DeviceId> {
        self.agents.get(&agent).map(|a| a.client.device().id())
    }

    pub async fn tick(&mut self) -> Result<TickReport, Error> {
        let mut report = TickReport::default();
        for hosted in Client::host_agents(&self.server, &self.token).await? {
            if !self.agents.contains_key(&hosted.user_id) {
                let agent = self.start(hosted.user_id, hosted.owner).await?;
                self.agents.insert(hosted.user_id, agent);
            }
        }
        let ids: Vec<UserId> = self.agents.keys().copied().collect();
        for id in ids {
            self.renew(id).await?;
            let agent = self.agents.get_mut(&id).expect("listed above");
            if let Err(e) = step(agent, &mut report).await {
                tracing::warn!(agent = %id, "sidekick step failed: {e}");
            }
        }
        Ok(report)
    }

    async fn start(&self, user: UserId, owner: UserId) -> Result<Agent, Error> {
        std::fs::create_dir_all(&self.dir).map_err(|e| anarchy_core::Error::Storage(e.to_string()))?;
        let device = Device::open_or_create(&self.dir.join(format!("{user}.db")), &self.key)?;
        let session = Client::host_session(&self.server, &self.token, user).await?;
        let client = Client::from_session(self.server.clone(), session, device);
        client.register_device().await?;
        if client.device().setting("key_packages")?.is_none() {
            client.publish_key_packages(KEY_PACKAGES).await?;
            client.device().set_setting("key_packages", b"1")?;
        }
        Ok(Agent {
            owner,
            client,
            dm: None,
            names: HashMap::new(),
        })
    }

    /// Gets a fresh session before the current one runs out.
    async fn renew(&mut self, id: UserId) -> Result<(), Error> {
        let agent = self.agents.get(&id).expect("known");
        if agent.client.session().expires_at_ms > now_ms() + 3_600_000 {
            return Ok(());
        }
        let session = Client::host_session(&self.server, &self.token, id).await?;
        let agent = self.agents.remove(&id).expect("known");
        let client = Client::from_session(self.server.clone(), session, agent.client.into_device());
        self.agents.insert(id, Agent { client, ..agent });
        Ok(())
    }
}

async fn step(agent: &mut Agent, report: &mut TickReport) -> Result<(), Error> {
    let joined = agent.client.accept_invites().await?;
    if !joined.is_empty() {
        // Each join used a key package; keep some for the next channel.
        agent.client.publish_key_packages(joined.len()).await?;
        report.joined.extend(&joined);
    }
    if agent.dm.is_none() || !joined.is_empty() {
        agent.dm = agent
            .client
            .channel_metas()
            .await?
            .into_iter()
            .find(|m| m.kind == ChannelKind::Dm && m.peer.as_ref().is_some_and(|p| p.user_id == agent.owner))
            .map(|m| m.id);
    }
    let mut questions = vec![];
    for channel in agent.client.device().channels() {
        let delivered = match agent.client.sync_and_store(channel).await {
            Ok(d) => d,
            // The server stopped serving it: its person left, or it was removed.
            Err(anarchy_core::Error::Api { status: 404, .. }) => {
                agent.client.forget_channel(channel)?;
                report.forgot.push(channel);
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        if !agent.client.device().has_channel(channel) {
            report.forgot.push(channel);
            continue;
        }
        if Some(channel) == agent.dm {
            for m in delivered {
                if let Some(text) = Content::decode(&m.body).text_body() {
                    questions.push(text.to_owned());
                }
            }
        }
    }
    if let Some(dm) = agent.dm {
        for q in questions {
            let answer = answer(agent, dm, &q).await?;
            agent.client.send_content(dm, &Content::text(answer)).await?;
            report.answered += 1;
        }
    }
    Ok(())
}

/// Words worth searching for: three letters or more, not the glue between them.
fn terms(q: &str) -> Vec<String> {
    const SKIP: &[&str] = &[
        "the", "and", "for", "what", "who", "when", "where", "about", "any", "did", "does", "was", "were",
        "are", "you", "can", "with", "from", "this", "that", "have", "has", "tell", "find", "show", "me",
        "is", "it",
    ];
    q.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| w.chars().count() >= 3 && !SKIP.contains(&w.as_str()))
        .collect()
}

// ---------- memory (D36) ----------
// What its person asked it to remember, kept in its own encrypted device on
// the host. "remember …", "what do you remember", "forget 2" / "forget …" /
// "forget everything". Searches look here too.

const MEMORY_MAX: usize = 200;

fn memory(agent: &Agent) -> Vec<String> {
    agent
        .client
        .device()
        .setting("memory")
        .ok()
        .flatten()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_memory(agent: &Agent, items: &[String]) -> Result<(), Error> {
    let bytes = serde_json::to_vec(items).unwrap_or_default();
    agent.client.device().set_setting("memory", &bytes)?;
    Ok(())
}

/// Handles a memory request, or returns `None` when it isn't one.
fn memory_reply(agent: &Agent, q: &str) -> Result<Option<String>, Error> {
    let t = q.trim();
    let lower = t.to_lowercase();
    let mut items = memory(agent);
    if let Some(rest) = ["remember that ", "remember ", "note that "]
        .iter()
        .find_map(|p| lower.starts_with(p).then(|| t[p.len()..].trim()))
    {
        let fact = rest.trim_end_matches('.').trim();
        if fact.is_empty() {
            return Ok(Some("What should I remember?".into()));
        }
        if items.iter().any(|i| i.eq_ignore_ascii_case(fact)) {
            return Ok(Some(format!("I already remember that: \u{201c}{fact}\u{201d}.")));
        }
        let first = items.is_empty();
        items.push(fact.chars().take(500).collect());
        if items.len() > MEMORY_MAX {
            items.remove(0);
        }
        save_memory(agent, &items)?;
        let mut reply = format!("Got it. I'll remember: \u{201c}{fact}\u{201d}.");
        if first {
            reply.push_str(
                " I keep my memory on the server, encrypted on disk; whoever runs the server could read it. \
                 Ask \u{201c}what do you remember\u{201d} to see it, or \u{201c}forget\u{201d} to take something out.",
            );
        }
        return Ok(Some(reply));
    }
    if [
        "what do you remember",
        "memory",
        "what do you know about me",
        "show memory",
    ]
    .iter()
    .any(|p| lower.trim_end_matches('?') == *p)
    {
        if items.is_empty() {
            return Ok(Some(
                "I don't remember anything yet. Tell me \u{201c}remember …\u{201d} and I will.".into(),
            ));
        }
        let list: Vec<String> = items
            .iter()
            .enumerate()
            .map(|(k, i)| format!("{}. {i}", k + 1))
            .collect();
        return Ok(Some(format!(
            "What I remember ({}):\n{}",
            items.len(),
            list.join("\n")
        )));
    }
    if let Some(rest) = lower.strip_prefix("forget") {
        let rest = rest.trim().trim_end_matches('.');
        if rest == "everything" || rest == "all" {
            save_memory(agent, &[])?;
            return Ok(Some(format!("Done. I forgot all {} things.", items.len())));
        }
        let at = rest
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .filter(|n| *n < items.len())
            .or_else(|| {
                (!rest.is_empty())
                    .then(|| items.iter().position(|i| i.to_lowercase().contains(rest)))
                    .flatten()
            });
        return Ok(Some(match at {
            Some(k) => {
                let gone = items.remove(k);
                save_memory(agent, &items)?;
                format!("Forgotten: \u{201c}{gone}\u{201d}.")
            }
            None => "I couldn't find that in what I remember. Ask \u{201c}what do you remember\u{201d} for the list.".into(),
        }));
    }
    Ok(None)
}

async fn answer(agent: &mut Agent, dm: ChannelId, q: &str) -> Result<String, Error> {
    if let Some(reply) = memory_reply(agent, q)? {
        return Ok(reply);
    }
    let readable: Vec<ChannelId> = agent
        .client
        .device()
        .channels()
        .into_iter()
        .filter(|c| *c != dm)
        .collect();
    let name = |client: &Client, c: ChannelId| {
        client
            .channel_info(c)
            .ok()
            .flatten()
            .map_or_else(|| "a channel".to_owned(), |(n, ..)| format!("#{n}"))
    };
    let ql = q.trim().to_lowercase();
    let told = |agent: &Agent, words: &[String]| -> Vec<String> {
        memory(agent)
            .into_iter()
            .filter(|m| {
                let l = m.to_lowercase();
                words.iter().any(|w| l.contains(w.as_str()))
            })
            .take(3)
            .collect()
    };
    if readable.is_empty() {
        let mine = told(agent, &terms(q));
        if !mine.is_empty() {
            return Ok(format!("From what you told me:\n• {}", mine.join("\n• ")));
        }
        return Ok(
            "I can't read any channels yet. Open a Company channel or desk and turn me on there; \
                   I never join Sealed channels."
                .into(),
        );
    }
    if ql.contains("what can you read") || ql == "channels" || ql.contains("which channels") {
        let list: Vec<String> = readable.iter().map(|c| name(&agent.client, *c)).collect();
        return Ok(format!("I can read {}: {}.", readable.len(), list.join(", ")));
    }
    let words = terms(q);
    if words.is_empty() {
        return Ok(
            "Ask me about something by name, like \u{201c}Acme invoice\u{201d}. No AI model is connected \
                   yet, so for now I search the channels you've let me read."
                .into(),
        );
    }
    let mut hits: Vec<(usize, u64, ChannelId, DeviceId, String)> = vec![];
    for &c in &readable {
        for m in agent.client.device().messages(c, 5000)? {
            let Some(text) = Content::decode(&m.content).text_body().map(str::to_owned) else {
                continue;
            };
            let lower = text.to_lowercase();
            let score = words.iter().filter(|w| lower.contains(w.as_str())).count();
            if score > 0 {
                hits.push((score, m.ts_ms, c, m.sender, text));
            }
        }
    }
    let remembered = told(agent, &words);
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    hits.truncate(5);
    if hits.is_empty() && !remembered.is_empty() {
        return Ok(format!("From what you told me:\n• {}", remembered.join("\n• ")));
    }
    if hits.is_empty() {
        return Ok(format!(
            "Nothing about \u{201c}{}\u{201d} in the {} {} you've let me read.",
            words.join(" "),
            readable.len(),
            if readable.len() == 1 {
                "channel"
            } else {
                "channels"
            }
        ));
    }
    let mut lines = vec![format!("Here's what I found ({}):", hits.len())];
    for (_, _, c, sender, text) in hits {
        let who = sender_name(agent, c, sender).await;
        let short: String = text.chars().take(140).collect();
        let more = if short.len() < text.len() { "…" } else { "" };
        lines.push(format!("• {} · {who}: {short}{more}", name(&agent.client, c)));
    }
    if !remembered.is_empty() {
        lines.push("From what you told me:".into());
        lines.extend(remembered.iter().map(|m| format!("• {m}")));
    }
    Ok(lines.join("\n"))
}

async fn sender_name(agent: &mut Agent, channel: ChannelId, sender: DeviceId) -> String {
    if let Some(n) = agent.names.get(&sender) {
        return n.clone();
    }
    if let Ok(members) = agent.client.members(channel).await {
        for m in members {
            let n = m.display_name.clone().unwrap_or_else(|| "Someone".into());
            agent.names.insert(m.device_id, n);
        }
    }
    // Someone who has since left the channel.
    agent
        .names
        .get(&sender)
        .cloned()
        .unwrap_or_else(|| "Someone".into())
}
