-- migrate:up
-- Similarity detection (docs/INSIGHTS.md, M2). Admins (set by SQL only:
-- UPDATE users SET is_admin = true WHERE login = '...') see the similarity
-- page; nobody else ever sees similarity data.
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- Winnowed k-gram fingerprints of each submission (api/src/similarity).
-- Computed lazily when the similarity page needs them; fp_version lets a
-- tokenizer change recompute them.
CREATE TABLE submission_fingerprints (
    submission_id uuid    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    problem_id    bigint  NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    hash          integer NOT NULL,
    line_from     integer NOT NULL,
    line_to       integer NOT NULL,
    PRIMARY KEY (submission_id, hash, line_from)
);
CREATE INDEX submission_fingerprints_problem_hash_idx ON submission_fingerprints (problem_id, hash);
ALTER TABLE submissions ADD COLUMN fp_version smallint;

-- migrate:down
ALTER TABLE submissions DROP COLUMN fp_version;
DROP TABLE submission_fingerprints;
ALTER TABLE users DROP COLUMN is_admin;
