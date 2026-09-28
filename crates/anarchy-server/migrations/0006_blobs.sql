-- Encrypted file chunks for drives. The server can't read them: each file's key
-- lives only inside the channel's end-to-end encrypted messages. Readable by
-- current members of the channel. Kept in Postgres for now; object storage later.
CREATE TABLE blobs (
    id                 uuid PRIMARY KEY,
    channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    size               integer NOT NULL,
    data               bytea NOT NULL,
    created_by_device  uuid NOT NULL REFERENCES devices(id),
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blobs_channel ON blobs (channel_id);
