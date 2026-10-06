-- Linking a phone to an account (D42). The desktop makes an offer and shows
-- its secret as a QR code; a phone claims it, the desktop approves, and the
-- phone collects a session. Only hashes of the secret and ticket are kept.
CREATE TABLE device_links (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash  bytea NOT NULL UNIQUE,
    ticket_hash  bytea UNIQUE,
    label        text,
    state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'approved', 'done', 'ended')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX device_links_user ON device_links(user_id);
