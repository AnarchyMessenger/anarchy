-- Removal keeps the membership row and records the sequence number of the commit
-- that removed the device. A removed device may still read events up to and
-- including that commit, so it learns it was removed and deletes its local copy;
-- it can't read or post anything after it.
ALTER TABLE channel_members ADD COLUMN removed_seq bigint;
CREATE INDEX channel_members_active ON channel_members(channel_id) WHERE removed_seq IS NULL;
