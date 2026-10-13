-- migrate:up

-- The program's actual stdout, stored for SAMPLE tests only (<= 4 KiB, with a
-- truncation flag) so the UI can show a diff against the public expected
-- output. The CHECK makes it impossible to store output of a hidden test.
ALTER TABLE submission_tests
    ADD COLUMN stdout text,
    ADD COLUMN stdout_truncated boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT submission_tests_stdout_samples_only
        CHECK (is_sample OR (stdout IS NULL AND NOT stdout_truncated)),
    ADD CONSTRAINT submission_tests_stdout_size
        CHECK (stdout IS NULL OR octet_length(stdout) <= 4096);

-- migrate:down
ALTER TABLE submission_tests
    DROP CONSTRAINT submission_tests_stdout_size,
    DROP CONSTRAINT submission_tests_stdout_samples_only,
    DROP COLUMN stdout_truncated,
    DROP COLUMN stdout;
