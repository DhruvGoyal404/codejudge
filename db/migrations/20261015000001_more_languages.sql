-- migrate:up
-- Phase 5.5 L: Java 21 and JavaScript (Node 22).
ALTER TABLE submissions DROP CONSTRAINT submissions_language_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_language_check
    CHECK (language IN ('cpp', 'python', 'java', 'javascript'));

-- migrate:down
-- Fails if java/javascript submissions exist (delete them first, deliberately).
ALTER TABLE submissions DROP CONSTRAINT submissions_language_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_language_check
    CHECK (language IN ('cpp', 'python'));
