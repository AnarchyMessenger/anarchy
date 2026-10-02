-- Presence (D35): what a person chose to show, and when their app last checked in.
ALTER TABLE users
    ADD COLUMN presence  text NOT NULL DEFAULT 'auto' CHECK (presence IN ('auto', 'busy', 'away', 'invisible')),
    ADD COLUMN last_seen timestamptz;
