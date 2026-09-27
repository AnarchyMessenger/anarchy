-- Anarchy server schema. Everything here is metadata or ciphertext: the server
-- never holds message plaintext or private keys.

CREATE TABLE orgs (
    id          uuid PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL REFERENCES orgs(id),
    oidc_issuer   text NOT NULL,
    oidc_subject  text NOT NULL,
    display_name  text,
    email         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (oidc_issuer, oidc_subject)
);

-- Only a SHA-256 hash of each session token is stored.
CREATE TABLE sessions (
    token_hash  bytea PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE devices (
    id             uuid PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signature_key  bytea NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    revoked_at     timestamptz
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE channels (
    id                 uuid PRIMARY KEY,
    org_id             uuid NOT NULL REFERENCES orgs(id),
    created_by_device  uuid NOT NULL REFERENCES devices(id),
    epoch              bigint NOT NULL DEFAULT 0,
    head               bigint NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- Which devices may read and append to a channel. Mirrors MLS membership for routing;
-- MLS alone decides who can decrypt.
CREATE TABLE channel_members (
    channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    added_seq   bigint NOT NULL,
    PRIMARY KEY (channel_id, device_id)
);
CREATE INDEX channel_members_device ON channel_members(device_id);

CREATE TABLE channel_events (
    channel_id       uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    seq              bigint NOT NULL,
    epoch            bigint NOT NULL,
    kind             text NOT NULL CHECK (kind IN ('commit', 'application')),
    sender_device    uuid NOT NULL REFERENCES devices(id),
    ts_ms            bigint NOT NULL,
    idempotency_key  uuid NOT NULL,
    payload          bytea NOT NULL,
    PRIMARY KEY (channel_id, seq),
    UNIQUE (channel_id, idempotency_key)
);

CREATE TABLE key_packages (
    id         bigserial PRIMARY KEY,
    device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    data       bytea NOT NULL
);
CREATE INDEX key_packages_device ON key_packages(device_id, id);

CREATE TABLE inbox (
    id          bigserial PRIMARY KEY,
    device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    welcome     bytea NOT NULL
);
CREATE INDEX inbox_device ON inbox(device_id, id);
