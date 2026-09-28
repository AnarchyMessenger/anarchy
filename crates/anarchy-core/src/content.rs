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
    },
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
            Content::ChannelInfo { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_plain_text() {
        let info = Content::ChannelInfo {
            name: "board".into(),
            topic: "Q4".into(),
            trust: Trust::Sealed,
        };
        assert_eq!(Content::decode(&info.encode()), info);
        assert_eq!(Content::decode(b"hello"), Content::text("hello"));
        assert_eq!(
            Content::decode(br#"{"t":"text","body":"hi"}"#).text_body(),
            Some("hi")
        );
    }
}
