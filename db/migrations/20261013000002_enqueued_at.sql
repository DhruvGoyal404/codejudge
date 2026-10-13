-- migrate:up

-- Last time the submission id was XADDed to judge:submissions. Set by the
-- API after a successful XADD and by the sweeper on re-enqueue, so the
-- sweeper only re-enqueues rows that have been waiting without a fresh
-- enqueue for longer than its threshold (instead of re-adding the whole
-- backlog on every sweep).
ALTER TABLE submissions ADD COLUMN enqueued_at timestamptz;
CREATE INDEX submissions_queued_enqueued_at ON submissions (enqueued_at) WHERE status = 'queued';

-- migrate:down
DROP INDEX submissions_queued_enqueued_at;
ALTER TABLE submissions DROP COLUMN enqueued_at;
