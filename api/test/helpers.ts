import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { pino, type Logger } from "pino";

import { loadConfig, type Config } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { Queue } from "../src/queue.ts";

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
