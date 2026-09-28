-- Personal accounts with handles (username#tag), spaces, and direct conversations.

ALTER TABLE users
    ADD COLUMN username        text,
    ADD COLUMN tag             integer CHECK (tag BETWEEN 1 AND 9999),
    ADD COLUMN color           text NOT NULL DEFAULT 'ember',
    ADD COLUMN avatar          text,
    ADD COLUMN usage           text CHECK (usage IN ('work', 'freelance', 'personal', 'community')),
    ADD COLUMN dm_policy       text NOT NULL DEFAULT 'spaces' CHECK (dm_policy IN ('anyone', 'spaces')),
    ADD COLUMN dm_humans_only  boolean NOT NULL DEFAULT false,
    ADD COLUMN is_agent        boolean NOT NULL DEFAULT false,
    ADD COLUMN onboarded       boolean NOT NULL DEFAULT false;
-- Usernames are stored lowercase; the pair is what identifies a person.
CREATE UNIQUE INDEX users_handle ON users (username, tag);

CREATE TABLE spaces (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES orgs(id),
    name        text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('company', 'community', 'personal', 'freelance')),
    -- On a company server: the organisation's own space, which everyone joins.
    is_default  boolean NOT NULL DEFAULT false,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spaces_one_default ON spaces (org_id) WHERE is_default;

CREATE TABLE space_members (
    space_id   uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_members_user ON space_members (user_id);

ALTER TABLE channels
    ADD COLUMN space_id  uuid REFERENCES spaces(id) ON DELETE CASCADE,
    ADD COLUMN kind      text NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel', 'dm')),
    -- A direct conversation is between exactly these two people.
    ADD COLUMN dm_a      uuid REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN dm_b      uuid REFERENCES users(id) ON DELETE CASCADE,
    ADD CONSTRAINT dm_has_people CHECK (kind <> 'dm' OR (dm_a IS NOT NULL AND dm_b IS NOT NULL));
CREATE INDEX channels_dm ON channels (dm_a, dm_b) WHERE kind = 'dm';

-- Invites with a space join that space (for people with an account); without, they
-- create a guest (company servers, D9).
ALTER TABLE invites ADD COLUMN space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;
