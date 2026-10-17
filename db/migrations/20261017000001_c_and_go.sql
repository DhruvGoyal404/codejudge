-- migrate:up
-- Phase 5.6: C (gcc, C17) and Go (1.27, standard library only).
ALTER TABLE submissions DROP CONSTRAINT submissions_language_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_language_check
    CHECK (language IN ('c', 'cpp', 'go', 'python', 'java', 'javascript'));

-- migrate:down
-- Fails if c/go submissions exist (delete them first, deliberately).
ALTER TABLE submissions DROP CONSTRAINT submissions_language_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_language_check
    CHECK (language IN ('cpp', 'python', 'java', 'javascript'));
