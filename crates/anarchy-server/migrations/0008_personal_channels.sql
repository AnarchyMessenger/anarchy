-- Personal channels: one person's own encrypted records (agenda, notes),
-- synced between their devices and nobody else's. Not in a space; dm_a holds
-- the owner, and only that person's devices can be added.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('channel', 'dm', 'personal'));
ALTER TABLE channels ADD CONSTRAINT personal_has_owner CHECK (kind <> 'personal' OR (dm_a IS NOT NULL AND dm_b IS NULL AND space_id IS NULL));
