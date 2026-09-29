-- Pay-this-invoice pages for people without an account (DESKS-PLAN "The client
-- side"). `sealed` is the page's content encrypted by the desk member's device;
-- the key is only in the link's #fragment, which browsers never send, so the
-- server stores ciphertext and learns only that a link exists and when it's opened.
CREATE TABLE pay_links (
    id                 text PRIMARY KEY,
    channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by_device  uuid NOT NULL REFERENCES devices(id),
    sealed             bytea NOT NULL,
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz,
    views              integer NOT NULL DEFAULT 0,
    last_viewed_at     timestamptz,
    claimed_paid_at    timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_links_channel ON pay_links (channel_id);
