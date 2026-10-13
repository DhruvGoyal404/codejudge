import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { pino, type Logger } from "pino";

import { loadConfig, type Config } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { Queue } from "../src/queue.ts";
import { newToken, SESSION_TTL_MS, sha256hex } from "../src/sessions.ts";

/** The browser-facing origin the API accepts for non-GET requests (config default). */
export const ORIGIN = "http://localhost:5173";

/** Fills CODEJUDGE_* URLs from the repo's .env when not already set. */
export function devEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.CODEJUDGE_DATABASE_URL || !env.CODEJUDGE_VALKEY_URL) {
    const dotenv = readFileSync(fileURLToPath(new URL("../../.env", import.meta.url)), "utf8");
    const kv = Object.fromEntries(
      dotenv
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    env.CODEJUDGE_DATABASE_URL ??= `postgres://codejudge:${kv.CODEJUDGE_PG_PASSWORD}@127.0.0.1:${kv.CODEJUDGE_PG_PORT ?? 55432}/codejudge?sslmode=disable`;
    env.CODEJUDGE_VALKEY_URL ??= `redis://127.0.0.1:${kv.CODEJUDGE_VALKEY_PORT ?? 56379}`;
  }
  return env;
}

export interface TestDeps {
  config: Config;
  db: Db;
  queue: Queue;
  hub: Hub;
  log: Logger;
  close(): Promise<void>;
}

/** Real Postgres + Valkey, with per-run stream names so tests never touch judge:* streams. */
export function testDeps(overrides: Record<string, string> = {}): TestDeps {
  const run = randomBytes(4).toString("hex");
  const config = loadConfig({
    ...devEnv(),
    SUBMISSIONS_STREAM: `test:${run}:submissions`,
    EVENTS_STREAM: `test:${run}:events`,
    SSE_KEEPALIVE_MS: "1000",
    ...overrides,
  });
  const db = Db.connect(config.CODEJUDGE_DATABASE_URL, 3);
  const queue = Queue.connect(config.CODEJUDGE_VALKEY_URL, config.SUBMISSIONS_STREAM);
  const hub = new Hub();
  const log: Logger = pino({ level: "silent" });
  return {
    config,
    db,
    queue,
    hub,
    log,
    async close() {
      await queue.redis.del(config.SUBMISSIONS_STREAM, config.EVENTS_STREAM);
      await Promise.allSettled([db.close(), queue.close()]);
    },
  };
}

export interface TestUser {
  userId: number;
  githubId: number;
  sessionId: string;
  token: string;
  /** Cookie header value for this session (dev cookie name). */
  cookie: string;
}

/**
 * Inserts a user and a session directly (bypassing OAuth). github_id is drawn
 * from a range real GitHub accounts don't use.
 */
export async function createTestUser(
  db: Db,
  { expiresInMs = SESSION_TTL_MS, lastSeenAgoMs = 0 }: { expiresInMs?: number; lastSeenAgoMs?: number } = {},
): Promise<TestUser> {
  const githubId = 9_000_000_000_000 + Math.floor(Math.random() * 1e12);
  const u = await db.pool.query(`INSERT INTO users (github_id, login) VALUES ($1, $2) RETURNING id`, [githubId, `test-${githubId}`]);
  const userId = Number(u.rows[0].id);
  const token = newToken();
  const sessionId = sha256hex(token);
  await db.pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, last_seen_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision / 1000),
             now() - make_interval(secs => $4::double precision / 1000))`,
    [sessionId, userId, expiresInMs, lastSeenAgoMs],
  );
  return { userId, githubId, sessionId, token, cookie: `cj_session=${token}` };
}

/** Removes test users with their submissions (sessions cascade). */
export async function deleteTestUsers(db: Db, userIds: number[]): Promise<void> {
  if (!userIds.length) return;
  await db.pool.query(`DELETE FROM submissions WHERE user_id = ANY($1::bigint[])`, [userIds]);
  await db.pool.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [userIds]);
}
