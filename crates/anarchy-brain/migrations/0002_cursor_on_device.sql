-- Sync cursors now live in the Brain's encrypted device database, next to its MLS state.
ALTER TABLE brain_channels DROP COLUMN cursor;
