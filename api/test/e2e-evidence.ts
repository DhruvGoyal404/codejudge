// Failure evidence for end-to-end suites: dumps the submissions (with their
// per-test rows) and the custom-run hashes of the given test users to
// <dir>/records.json, so a rare failure (e.g. an unexplained IE) can be
// diagnosed after the run. Used instead of cleanup when a test failed.
//
//   tsx test/e2e-evidence.ts <dir> shortcut            # web e2e: github_id < 0
//   tsx test/e2e-evidence.ts <dir> 12,13,14 [prefix]   # API e2e: these user ids
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Redis } from "ioredis";

import { Db } from "../src/db.ts";
import { devEnv } from "./helpers.ts";

export async function dumpEvidence(db: Db, redis: Redis, dir: string, userIds: number[], runPrefix = "judge:run:") {
  mkdirSync(dir, { recursive: true });
  const subs = await db.pool.query(
    `SELECT s.*, (SELECT json_agg(t ORDER BY t.seq) FROM submission_tests t WHERE t.submission_id = s.id) AS tests
       FROM submissions s WHERE s.user_id = ANY($1::bigint[]) ORDER BY s.created_at`,
    [userIds],
  );
  const runs: Record<string, Record<string, string>> = {};
  const owners = new Set(userIds.map(String));
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${runPrefix}*`, "COUNT", 500);
    cursor = next;
    for (const k of keys) {
      if (k.includes(":active:")) continue;
      const h = await redis.hgetall(k).catch(() => ({}) as Record<string, string>);
      if (owners.has(h.user ?? "")) runs[k] = h;
    }
  } while (cursor !== "0");
  const file = join(dir, "records.json");
  writeFileSync(file, JSON.stringify({ users: userIds, submissions: subs.rows, runs }, null, 2));
  return { file, submissions: subs.rowCount ?? 0, runs: Object.keys(runs).length };
}

if (process.argv[1]?.endsWith("e2e-evidence.ts")) {
  const [dir, who, prefix] = process.argv.slice(2);
  if (!dir || !who) {
    process.stderr.write("usage: e2e-evidence.ts <dir> shortcut|<user ids> [run key prefix]\n");
    process.exit(2);
  }
  const env = devEnv();
  const db = Db.connect(env.CODEJUDGE_DATABASE_URL!, 1);
  const redis = new Redis(env.CODEJUDGE_VALKEY_URL!);
  try {
    const ids =
      who === "shortcut"
        ? (await db.pool.query(`SELECT id FROM users WHERE github_id < 0`)).rows.map((r) => Number(r.id))
        : who.split(",").map(Number);
    const r = await dumpEvidence(db, redis, dir, ids, prefix);
    process.stdout.write(`evidence: ${r.submissions} submissions, ${r.runs} runs -> ${r.file}\n`);
  } finally {
    redis.disconnect();
    await db.close();
  }
}
