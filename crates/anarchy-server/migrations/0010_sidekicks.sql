-- A person's sidekick (their own agent) as others see it: a name and a look,
-- shown as a badge on the person's avatar and on anything the sidekick writes.
ALTER TABLE users ADD COLUMN sidekick_name text, ADD COLUMN sidekick_look text;
