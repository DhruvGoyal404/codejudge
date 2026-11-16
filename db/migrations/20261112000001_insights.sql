-- migrate:up
-- Insights (docs/INSIGHTS.md): a problem's size ladder, imported by
-- judge-admin import from the private problems repo (NULL: no ladder yet).
ALTER TABLE problems
    ADD COLUMN ladder_hash text,
    ADD COLUMN ladder_label text,
    ADD COLUMN ladder_reference text;

-- One analysis per (problem, language, exact code, ladder): a cache shared by
-- everyone who submits byte-identical code. The source is read from
-- submission_id (the first request); the report holds only sizes and
-- measurements, never program output or ladder inputs.
CREATE TABLE insights (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    problem_id    bigint NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    language      text NOT NULL CHECK (language IN ('c', 'cpp', 'go', 'python', 'java', 'javascript')),
    code_sha256   bytea NOT NULL CHECK (octet_length(code_sha256) = 32),
    ladder_hash   text NOT NULL,
    submission_id uuid NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    report        jsonb,
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz,
    finished_at   timestamptz,
    UNIQUE (problem_id, language, code_sha256, ladder_hash),
    CHECK ((status = 'done') = (report IS NOT NULL))
);
CREATE INDEX insights_submission_idx ON insights (submission_id);

-- migrate:down
DROP TABLE insights;
ALTER TABLE problems
    DROP COLUMN ladder_hash,
    DROP COLUMN ladder_label,
    DROP COLUMN ladder_reference;
