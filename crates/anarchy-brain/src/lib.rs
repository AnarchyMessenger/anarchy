//! The Company Brain.
//!
//! The Brain is an ordinary member device (ARCHITECTURE §9). It reads only the
//! channels someone added it to, over the same end-to-end encrypted path as
//! every other member, and indexes what it reads in its own database.
//!
//! Its central rule, borrowed from Supermemory's company-brain permissions
//! model: **what the Brain may use depends on who will see the answer.** Each
//! message is stored against exactly one channel, the room it was said in.
//! A search names its audience:
//!
//! - [`Scope::AskedBy`]: a private answer to one user (a DM with the Brain, or
//!   an agent calling the Company MCP for that user). Every channel that user
//!   belongs to is in scope.
//! - [`Scope::PostingTo`]: an answer posted in a channel. Only channels whose
//!   members *all* already belong to that channel's audience are in scope, so
//!   nothing reaches someone who couldn't already read it.

use anarchy_core::Client;
use anarchy_proto::{ChannelId, DeviceId, UserId};
use sqlx::PgPool;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Core(#[from] anarchy_core::Error),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error("the Brain is not a member of channel {0}, so it can't answer there")]
    NotInChannel(ChannelId),
}

/// Who will see the result of a search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// A private answer to one user.
    AskedBy(UserId),
    /// An answer posted in a channel, visible to all its members.
    PostingTo(ChannelId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub channel: ChannelId,
    pub seq: u64,
    pub sender: Option<UserId>,
    pub body: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct IngestReport {
    pub joined: Vec<ChannelId>,
    pub messages: usize,
    /// Channels the Brain was removed from. Their index has been purged.
    pub removed_from: Vec<ChannelId>,
}

pub struct Brain {
    client: Client,
    db: PgPool,
}

impl Brain {
    /// `client` is signed in as the Brain's service account, on a persistent
    /// device (see [`anarchy_core::Device::open_or_create`]). `db` is the Brain's own database.
    pub async fn new(client: Client, db: PgPool) -> Result<Self, Error> {
        MIGRATOR.run(&db).await.map_err(sqlx::Error::from)?;
        Ok(Self { client, db })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Joins channels the Brain was added to, pulls new messages from every
    /// channel it's in, refreshes membership, and purges channels it was removed from.
    pub async fn ingest(&mut self) -> Result<IngestReport, Error> {
        let mut report = IngestReport {
            joined: self.client.accept_invites().await?,
            ..Default::default()
        };
        for channel in &report.joined {
            // A re-invite after removal starts from a clean index.
            sqlx::query("DELETE FROM brain_channels WHERE channel_id = $1")
                .bind(channel)
                .execute(&self.db)
                .await?;
            sqlx::query("INSERT INTO brain_channels (channel_id) VALUES ($1)")
                .bind(channel)
                .execute(&self.db)
                .await?;
        }

        let channels: Vec<ChannelId> =
            sqlx::query_scalar("SELECT channel_id FROM brain_channels ORDER BY channel_id")
                .fetch_all(&self.db)
                .await?;
        for channel in channels {
            let delivered = if self.client.device().has_channel(channel) {
                self.client.sync(channel).await?
            } else {
                vec![]
            };
            if !self.client.device().has_channel(channel) {
                // Removed from the channel (or its MLS state is gone): forget everything
                // the Brain learned there, including what it read before the removal.
                self.purge(channel).await?;
                report.removed_from.push(channel);
                continue;
            }
            self.refresh_members(channel).await?;

            // Known gap: the device cursor advanced inside `sync`. A crash before this
            // write drops these messages from the index (not from the channel).
            let mut tx = self.db.begin().await?;
            for msg in &delivered {
                // Non-UTF-8 payloads (future attachments, reactions) aren't text to index.
                let Ok(body) = std::str::from_utf8(&msg.body) else {
                    continue;
                };
                sqlx::query(
                    "INSERT INTO brain_chunks (channel_id, seq, sender_device, body) VALUES ($1, $2, $3, $4)
                     ON CONFLICT DO NOTHING",
                )
                .bind(channel)
                .bind(msg.seq as i64)
                .bind(msg.sender)
                .bind(body)
                .execute(&mut *tx)
                .await?;
                report.messages += 1;
            }
            tx.commit().await?;
        }
        Ok(report)
    }

    /// Deletes everything indexed from a channel.
    async fn purge(&self, channel: ChannelId) -> Result<(), Error> {
        // Chunks and members go with it (ON DELETE CASCADE).
        sqlx::query("DELETE FROM brain_channels WHERE channel_id = $1")
            .bind(channel)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    async fn refresh_members(&self, channel: ChannelId) -> Result<(), Error> {
        let members = self.client.members(channel).await?;
        let mut tx = self.db.begin().await?;
        sqlx::query("DELETE FROM brain_members WHERE channel_id = $1")
            .bind(channel)
            .execute(&mut *tx)
            .await?;
        for m in &members {
            sqlx::query(
                "INSERT INTO brain_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(channel)
            .bind(m.user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO brain_devices (device_id, user_id) VALUES ($1, $2)
                 ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id",
            )
            .bind(m.device_id)
            .bind(m.user_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Channels whose content may be shown to `scope`'s audience.
    pub async fn readable_channels(&self, scope: Scope) -> Result<Vec<ChannelId>, Error> {
        let rows: Vec<(ChannelId,)> = match scope {
            Scope::AskedBy(user) => {
                sqlx::query_as("SELECT channel_id FROM brain_members WHERE user_id = $1 ORDER BY channel_id")
                    .bind(user)
                    .fetch_all(&self.db)
                    .await?
            }
            Scope::PostingTo(dest) => {
                let known: Option<(i32,)> =
                    sqlx::query_as("SELECT 1 FROM brain_channels WHERE channel_id = $1")
                        .bind(dest)
                        .fetch_optional(&self.db)
                        .await?;
                if known.is_none() {
                    return Err(Error::NotInChannel(dest));
                }
                // Source S is allowed when no member of the destination is missing from S.
                sqlx::query_as(
                    "SELECT c.channel_id FROM brain_channels c
                     WHERE NOT EXISTS (
                         SELECT 1 FROM brain_members d
                         WHERE d.channel_id = $1
                           AND NOT EXISTS (SELECT 1 FROM brain_members s
                                           WHERE s.channel_id = c.channel_id AND s.user_id = d.user_id))
                     ORDER BY c.channel_id",
                )
                .bind(dest)
                .fetch_all(&self.db)
                .await?
            }
        };
        Ok(rows.into_iter().map(|(c,)| c).collect())
    }

    /// Full-text search over the channels `scope` may see, best matches first.
    pub async fn search(&self, scope: Scope, query: &str, limit: u32) -> Result<Vec<Hit>, Error> {
        let channels = self.readable_channels(scope).await?;
        let rows: Vec<(ChannelId, i64, Option<UserId>, String)> = sqlx::query_as(
            "SELECT k.channel_id, k.seq, d.user_id, k.body
             FROM brain_chunks k LEFT JOIN brain_devices d ON d.device_id = k.sender_device
             WHERE k.channel_id = ANY($1) AND k.tsv @@ websearch_to_tsquery('simple', $2)
             ORDER BY ts_rank(k.tsv, websearch_to_tsquery('simple', $2)) DESC, k.channel_id, k.seq
             LIMIT $3",
        )
        .bind(&channels)
        .bind(query)
        .bind(limit.clamp(1, 100) as i64)
        .fetch_all(&self.db)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(channel, seq, sender, body)| Hit {
                channel,
                seq: seq as u64,
                sender,
                body,
            })
            .collect())
    }

    /// The user behind a device, as last seen in a channel's member list.
    pub async fn user_of(&self, device: DeviceId) -> Result<Option<UserId>, Error> {
        Ok(
            sqlx::query_scalar("SELECT user_id FROM brain_devices WHERE device_id = $1")
                .bind(device)
                .fetch_optional(&self.db)
                .await?,
        )
    }
}
