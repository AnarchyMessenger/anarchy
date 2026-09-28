-- Guests: people without an account at the organisation's identity provider.
-- They join with an invite code a member created, pick a display name, and
-- their access ends when the invite expires.
ALTER TABLE users ADD COLUMN is_guest boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN expires_at timestamptz;

CREATE TABLE invites (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES orgs(id),
    -- SHA-256 of the code; the code itself is shown once, to its creator.
    code_hash   bytea NOT NULL UNIQUE,
    created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    max_uses    integer NOT NULL CHECK (max_uses > 0),
    uses        integer NOT NULL DEFAULT 0,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Which invite each guest came through, for audits and revoking a batch.
ALTER TABLE users ADD COLUMN invite_id uuid REFERENCES invites(id);
