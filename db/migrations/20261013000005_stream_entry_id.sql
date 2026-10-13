-- migrate:up
-- The judge:submissions entry id of the submission's current XADD (set after
-- a successful XADD). NULL: never successfully enqueued. The sweeper re-enqueues
-- a queued submission only when this is NULL or the entry is gone from the
-- stream, so a backlog never produces duplicate entries.
ALTER TABLE submissions ADD COLUMN stream_entry_id text CHECK (stream_entry_id ~ '^[0-9]+-[0-9]+$');

-- migrate:down
ALTER TABLE submissions DROP COLUMN stream_entry_id;
