-- migrate:up
-- Counts a user's queued|running submissions for the per-user active cap.
CREATE INDEX submissions_user_active ON submissions (user_id) WHERE status IN ('queued', 'running');

-- migrate:down
DROP INDEX submissions_user_active;
