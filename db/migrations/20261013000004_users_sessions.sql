-- migrate:up
CREATE TABLE users (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    github_id  bigint      NOT NULL UNIQUE,
    login      text        NOT NULL,
    avatar_url text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- id is the SHA-256 (hex) of the raw session token; the raw token exists only
-- in the cookie, never at rest.
CREATE TABLE sessions (
    id           text        PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- NULL for anonymous submissions (pre-auth history).
ALTER TABLE submissions ADD COLUMN user_id bigint REFERENCES users (id);
-- Keyset pagination for GET /me/submissions on (created_at, id).
CREATE INDEX submissions_user_created_at ON submissions (user_id, created_at DESC, id DESC);

-- migrate:down
DROP INDEX submissions_user_created_at;
ALTER TABLE submissions DROP COLUMN user_id;
DROP TABLE sessions;
DROP TABLE users;
