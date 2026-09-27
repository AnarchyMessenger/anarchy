-- The Company Brain's own database. It holds plaintext of the channels the Brain
-- was added to, so it runs on the organisation's infrastructure only
-- (ARCHITECTURE §9) and is encrypted at rest by the org.

-- Channels the Brain is a member of, with its sync cursor.
CREATE TABLE brain_channels (
    channel_id  uuid PRIMARY KEY,
    cursor      bigint NOT NULL DEFAULT 0,
    joined_at   timestamptz NOT NULL DEFAULT now()
);

-- Current members of each channel (users, not devices), refreshed on every ingest.
-- Every search is filtered through this table.
CREATE TABLE brain_members (
    channel_id  uuid NOT NULL REFERENCES brain_channels(channel_id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX brain_members_user ON brain_members(user_id);

CREATE TABLE brain_devices (
    device_id  uuid PRIMARY KEY,
    user_id    uuid NOT NULL
);

-- One row per message. Written to exactly one channel: the room it was said in.
CREATE TABLE brain_chunks (
    channel_id     uuid NOT NULL REFERENCES brain_channels(channel_id) ON DELETE CASCADE,
    seq            bigint NOT NULL,
    sender_device  uuid NOT NULL,
    body           text NOT NULL,
    tsv            tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
    PRIMARY KEY (channel_id, seq)
);
CREATE INDEX brain_chunks_tsv ON brain_chunks USING gin(tsv);
