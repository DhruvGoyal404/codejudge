-- migrate:up

-- Problem metadata imported from problems/<slug> by `judge-admin import`.
-- Test files stay on disk (worker only); content_hash pins the exact package.
CREATE TABLE problems (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug            text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    title           text        NOT NULL,
    statement_md    text        NOT NULL,
    time_limit_ms   integer     NOT NULL CHECK (time_limit_ms > 0 AND time_limit_ms <= 5000),
    memory_limit_mb integer     NOT NULL CHECK (memory_limit_mb BETWEEN 16 AND 1024),
    checker         jsonb       NOT NULL,
    content_hash    text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Public samples only (the API serves these; it never reads test files).
CREATE TABLE problem_samples (
    problem_id bigint  NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    seq        integer NOT NULL CHECK (seq >= 1),
    name       text    NOT NULL,
    input      text    NOT NULL,
    output     text    NOT NULL,
    PRIMARY KEY (problem_id, seq)
);

CREATE TABLE submissions (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    problem_id       bigint      NOT NULL REFERENCES problems (id),
    language         text        NOT NULL CHECK (language IN ('cpp', 'python')),
    source           text        NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 65536),
    status           text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done')),
    verdict          text        CHECK (verdict IN ('AC', 'WA', 'CE', 'RE', 'TLE', 'MLE', 'OLE', 'IE')),
    reason           text,
    failed_test      text,
    failed_is_sample boolean,
    max_cpu_ms       integer,
    max_rss_kb       integer,
    attempt          integer     NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    worker_id        text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    finished_at      timestamptz,
    -- a finished submission always has a verdict, an unfinished one never does
    CHECK ((status = 'done') = (verdict IS NOT NULL))
);

-- Sweeper (queued older than N s), worker claim, dashboards.
CREATE INDEX submissions_status_created_at ON submissions (status, created_at);
CREATE INDEX submissions_problem_created_at ON submissions (problem_id, created_at DESC);

CREATE TABLE submission_tests (
    submission_id uuid    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    seq           integer NOT NULL CHECK (seq >= 1),
    name          text    NOT NULL,
    is_sample     boolean NOT NULL,
    status        text    NOT NULL CHECK (status IN ('AC', 'WA', 'RE', 'TLE', 'MLE', 'OLE', 'IE')),
    cpu_ms        integer NOT NULL,
    rss_kb        integer NOT NULL,
    PRIMARY KEY (submission_id, seq) -- no duplicate rows per test
);

-- migrate:down
DROP TABLE submission_tests;
DROP TABLE submissions;
DROP TABLE problem_samples;
DROP TABLE problems;
