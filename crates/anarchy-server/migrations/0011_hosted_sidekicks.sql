-- A sidekick that runs on the server is its own account, tied to the person it
-- works for (D32). Only that person can add its devices to a channel, only to
-- channels they're in, and it reads a channel only while they're still in it.
ALTER TABLE users ADD COLUMN agent_of uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX users_agent_of ON users (agent_of) WHERE agent_of IS NOT NULL;
