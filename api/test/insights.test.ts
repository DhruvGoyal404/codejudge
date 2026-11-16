import { createHash, randomBytes } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { createTestUser, deleteTestUsers, ORIGIN, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

let d: TestDeps;
let app: ReturnType<typeof createApp>;
let alice: TestUser;
let bob: TestUser;
let saved: { ladder_hash: string | null; ladder_label: string | null; ladder_reference: string | null };
const SLUG = "pair-sums";
const LADDER = "test-ladder-" + randomBytes(4).toString("hex");

/** A finished submission by u with a fresh source (so the cache starts empty). */
async function submission(u: TestUser, verdict: string | null, status = "done", source = `// ${randomBytes(8).toString("hex")}\nint main(){}`) {
  const r = await d.db.pool.query(
    `INSERT INTO submissions (problem_id, language, source, status, verdict, user_id, finished_at)
     SELECT id, 'cpp', $2, $3, $4, $1, CASE WHEN $3 = 'done' THEN now() END FROM problems WHERE slug = '${SLUG}' RETURNING id`,
    [u.userId, source, status, verdict],
  );
  return r.rows[0].id as string;
}
const post = (u: TestUser, id: string) => request(app).post(`/submissions/${id}/insights`).set("Origin", ORIGIN).set("Cookie", u.cookie);
const get = (u: TestUser, id: string) => request(app).get(`/submissions/${id}/insights`).set("Cookie", u.cookie);
const entries = async () => (await d.queue.redis.xrange(d.config.INSIGHTS_STREAM, "-", "+")).map(([, f]) => f[1]);

beforeAll(async () => {
  d = testDeps();
  app = createApp(d);
  alice = await createTestUser(d.db);
  bob = await createTestUser(d.db);
  saved = (await d.db.pool.query(`SELECT ladder_hash, ladder_label, ladder_reference FROM problems WHERE slug = $1`, [SLUG])).rows[0];
  await d.db.pool.query(`UPDATE problems SET ladder_hash = $2, ladder_label = 'n = items', ladder_reference = 'n' WHERE slug = $1`, [SLUG, LADDER]);
});

afterAll(async () => {
  await d.db.pool.query(`DELETE FROM insights WHERE ladder_hash = $1`, [LADDER]);
  await d.db.pool.query(`UPDATE problems SET ladder_hash = $2, ladder_label = $3, ladder_reference = $4 WHERE slug = $1`, [
    SLUG,
    saved.ladder_hash,
    saved.ladder_label,
    saved.ladder_reference,
  ]);
  await deleteTestUsers(d.db, [alice.userId, bob.userId]);
  await d.close();
});

describe("Insights routes", () => {
  it("are owner-only: login required, someone else's submission looks missing", async () => {
    const id = await submission(alice, "AC");
    expect((await request(app).get(`/submissions/${id}/insights`)).status).toBe(401);
    expect((await request(app).post(`/submissions/${id}/insights`).set("Origin", ORIGIN)).status).toBe(401);
    expect((await get(bob, id)).status).toBe(404);
    expect((await post(bob, id)).status).toBe(404);
    expect((await get(alice, "not-a-uuid")).status).toBe(400);
    // The Origin check covers the new POST route too.
    expect((await request(app).post(`/submissions/${id}/insights`).set("Origin", "https://evil.example").set("Cookie", alice.cookie)).status).toBe(403);
  });

  it("explains why a submission can't be analyzed", async () => {
    const wa = await submission(alice, "WA");
    const g = await get(alice, wa);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ eligible: false, status: "none", label: "n = items", reference: "n" });
    expect((await post(alice, wa)).status).toBe(409);
    expect((await post(alice, await submission(alice, null, "queued"))).status).toBe(409);
    expect(await entries()).toEqual([]);
  });

  it("queues once, then serves the cached row for identical code", async () => {
    const source = `// same ${randomBytes(4).toString("hex")}\nint main(){}`;
    const a = await submission(alice, "TLE", "done", source);
    const r = await post(alice, a);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ eligible: true, status: "queued", report: null });
    const row = (await d.db.pool.query(`SELECT id, submission_id, code_sha256 FROM insights WHERE ladder_hash = $1 AND submission_id = $2`, [LADDER, a])).rows[0];
    expect(row.code_sha256.equals(createHash("sha256").update(source).digest())).toBe(true);
    expect(await entries()).toEqual([String(row.id)]);

    // Repeating while queued neither queues again nor counts.
    expect((await post(alice, a)).status).toBe(202);
    expect(await entries()).toHaveLength(1);

    // Done: everyone with byte-identical code gets the report, free.
    const report = { status: "ok", time: { class: "n^2", confidence: 0.97 }, steps: [{ n: 10, cpu_ms: 1, rss_kb: 900, status: "OK" }] };
    await d.db.pool.query(`UPDATE insights SET status = 'done', report = $2, finished_at = now() WHERE id = $1`, [row.id, report]);
    const b = await submission(bob, "AC", "done", source);
    const hit = await post(bob, b);
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ status: "done", report });
    expect(await entries()).toHaveLength(1);
    expect(hit.headers["cache-control"]).toContain("no-store");
  });

  it("re-queues a failed or stale analysis", async () => {
    const id = await submission(alice, "AC");
    await post(alice, id);
    const row = (await d.db.pool.query(`SELECT id FROM insights WHERE submission_id = $1`, [id])).rows[0];
    await d.db.pool.query(`UPDATE insights SET status = 'running', started_at = now(), created_at = now() - interval '1 hour' WHERE id = $1`, [row.id]);
    expect((await get(alice, id)).body).toMatchObject({ status: "failed", error: "The analysis was interrupted; try again." });
    const before = (await entries()).length;
    expect((await post(alice, id)).status).toBe(202);
    expect((await entries()).length).toBe(before + 1);
    expect((await d.db.pool.query(`SELECT status FROM insights WHERE id = $1`, [row.id])).rows[0].status).toBe("queued");
  });

  it("has its own rate limit; cache hits don't count", async () => {
    const lim = testDeps({ INSIGHT_LIMIT_PER_MIN: "1" });
    const limApp = createApp(lim);
    const u = await createTestUser(lim.db);
    const p = (id: string) => request(limApp).post(`/submissions/${id}/insights`).set("Origin", ORIGIN).set("Cookie", u.cookie);
    const first = await submission(u, "AC");
    expect((await p(first)).status).toBe(202);
    expect((await p(first)).status).toBe(202); // already queued: free
    const second = await p(await submission(u, "AC"));
    expect(second.status).toBe(429);
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    await lim.db.pool.query(`DELETE FROM insights WHERE ladder_hash = $1`, [LADDER]);
    await deleteTestUsers(lim.db, [u.userId]);
    await lim.close();
  });
});
