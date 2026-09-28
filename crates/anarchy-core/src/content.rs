//! What goes inside an encrypted message.
//!
//! Everything here is end-to-end encrypted, channel names included: the server
//! only ever sees ciphertext, so it doesn't learn what a channel is called.

use serde::{Deserialize, Serialize};

/// Who can read a channel (ARCHITECTURE §9, D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    /// People only; agents run on members' devices.
    #[default]
    Sealed,
    /// The Company Brain may be added as a visible member.
    Company,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Content {
    Text {
        body: String,
    },
    /// Sets or renames the channel. The latest one wins.
    ChannelInfo {
        name: String,
        #[serde(default)]
        topic: String,
        #[serde(default)]
        trust: Trust,
        /// Set when the channel is a desk, e.g. `"collections"` (DESKS-PLAN.md).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        desk: Option<String>,
    },
    /// Creates or replaces one record on a desk (an invoice, a request, a job).
    /// The latest `item` with the same `id` wins; `data` is the whole record.
    Item {
        id: String,
        kind: String,
        data: serde_json::Value,
    },
    /// Several records at once: the current state, re-shared when someone joins
    /// (they can't read messages from before they were added).
    Items {
        items: Vec<ItemRecord>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemRecord {
    pub id: String,
    pub kind: String,
    pub data: serde_json::Value,
}

/// A desk record as it stands after every update.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeskItem {
    pub id: String,
    pub kind: String,
    pub data: serde_json::Value,
    /// Sequence number and time of the latest change.
    pub seq: u64,
    pub updated_ms: u64,
}

/// Folds a channel's history into its desk records, in order, latest write wins.
pub fn fold_items<'a>(history: impl IntoIterator<Item = (u64, u64, &'a [u8])>) -> Vec<DeskItem> {
    let mut items: Vec<DeskItem> = Vec::new();
    let put = |items: &mut Vec<DeskItem>, item: DeskItem| match items.iter_mut().find(|i| i.id == item.id) {
        Some(existing) => *existing = item,
        None => items.push(item),
    };
    for (seq, ts, bytes) in history {
        match Content::decode(bytes) {
            Content::Item { id, kind, data } => put(
                &mut items,
                DeskItem {
                    id,
                    kind,
                    data,
                    seq,
                    updated_ms: ts,
                },
            ),
            Content::Items { items: batch } => {
                for r in batch {
                    put(
                        &mut items,
                        DeskItem {
                            id: r.id,
                            kind: r.kind,
                            data: r.data,
                            seq,
                            updated_ms: ts,
                        },
                    );
                }
            }
            _ => {}
        }
    }
    items
}

impl Content {
    pub fn text(body: impl Into<String>) -> Self {
        Content::Text { body: body.into() }
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("content always serialises")
    }

    /// Reads a message. Anything that isn't a known envelope (older clients,
    /// plain UTF-8) is shown as text rather than dropped.
    pub fn decode(bytes: &[u8]) -> Self {
        serde_json::from_slice(bytes).unwrap_or_else(|_| Content::Text {
            body: String::from_utf8_lossy(bytes).into_owned(),
        })
    }

    /// The searchable text, if any.
    pub fn text_body(&self) -> Option<&str> {
        match self {
            Content::Text { body } => Some(body),
            Content::ChannelInfo { .. } | Content::Item { .. } | Content::Items { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_fold_latest_write_wins() {
        let put = |id: &str, amount: u32| {
            Content::Item {
                id: id.into(),
                kind: "invoice".into(),
                data: serde_json::json!({ "amount": amount }),
            }
            .encode()
        };
        let (a1, b1, a2, text) = (
            put("a", 100),
            put("b", 7),
            put("a", 250),
            Content::text("hi").encode(),
        );
        let items = fold_items([
            (1, 10, &a1[..]),
            (2, 20, &b1[..]),
            (3, 30, &text[..]),
            (4, 40, &a2[..]),
        ]);
        assert_eq!(items.len(), 2);
        assert_eq!(
            (
                items[0].id.as_str(),
                items[0].data["amount"].as_u64(),
                items[0].seq
            ),
            ("a", Some(250), 4)
        );
        assert_eq!(items[1].id, "b");

        // A snapshot (what a newcomer gets) folds the same way.
        let snap = Content::Items {
            items: items
                .iter()
                .map(|i| ItemRecord {
                    id: i.id.clone(),
                    kind: i.kind.clone(),
                    data: i.data.clone(),
                })
                .collect(),
        }
        .encode();
        assert_eq!(
            fold_items([(9, 90, &snap[..])])
                .iter()
                .map(|i| &i.data)
                .collect::<Vec<_>>(),
            items.iter().map(|i| &i.data).collect::<Vec<_>>()
        );
    }

    #[test]
    fn round_trips_and_tolerates_plain_text() {
        let info = Content::ChannelInfo {
            name: "board".into(),
            topic: "Q4".into(),
            trust: Trust::Sealed,
            desk: None,
        };
        assert_eq!(Content::decode(&info.encode()), info);
        // Older clients' channel info (no desk field) still reads.
        assert!(matches!(
            Content::decode(br#"{"t":"channel_info","name":"x"}"#),
            Content::ChannelInfo { desk: None, .. }
        ));
        assert_eq!(Content::decode(b"hello"), Content::text("hello"));
        assert_eq!(
            Content::decode(br#"{"t":"text","body":"hi"}"#).text_body(),
            Some("hi")
        );
    }
}
