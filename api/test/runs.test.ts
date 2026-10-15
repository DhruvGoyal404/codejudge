import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, MAX_SOURCE_BYTES } from "../src/app.ts";
import { MAX_RUN_INPUT_BYTES } from "../src/runs.ts";
import { createTestUser, deleteTestUsers, ORIGIN, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

let d: TestDeps;
let app: ReturnType<typeof createApp>;
let alice: TestUser;
let bob: TestUser;
const ok = { problemSlug: "ledger-total", language: "cpp", source: "int main(){}", input: "1\n5\n" };
const post = (u: TestUser, body: object) => request(app).post("/runs").set("Origin", ORIGIN).set("Cookie", u.cookie).send(body);
const key = (id: string) => `${d.config.RUN_KEY_PREFIX}${id}`;

beforeAll(async () => {
  d = testDeps();
  app = createApp(d);
  alice = await createTestUser(d.db);
  bob = await createTestUser(d.db);
});

afterAll(async () => {
  await deleteTestUsers(d.db, [alice.userId, bob.userId]);
  await d.close();
});

describe("POST /runs (custom input)", () => {
  it("requires login", async () => {
    expect((await request(app).post("/runs").set("Origin", ORIGIN).send(ok)).status).toBe(401);
  });

  it("validates the body and sizes", async () => {
    expect((await post(alice, { ...ok, language: "rust" })).status).toBe(400);
    expect((await post(alice, { ...ok, input: undefined })).status).toBe(400);
    expect((await post(alice, { ...ok, extra: 1 })).status).toBe(400);
    expect((await post(alice, { ...ok, problemSlug: "no-such-problem" })).status).toBe(404);
    expect((await post(alice, { ...ok, source: "a".repeat(MAX_SOURCE_BYTES + 1) })).status).toBe(413);
    expect((await post(alice, { ...ok, input: "é".repeat(MAX_RUN_INPUT_BYTES / 2 + 1) })).status).toBe(413);
  });

  it("stores the job with a TTL, queues it, and allows one run in progress per user", async () => {
    const r = await post(alice, ok);
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    const job = await d.queue.redis.hgetall(key(id));
    expect(job).toMatchObject({ user: String(alice.userId), slug: "ledger-total", language: "cpp", input: "1\n5\n", status: "queued" });
    expect(await d.queue.redis.ttl(key(id))).toBeGreaterThan(0);
    const entries = await d.queue.redis.xrange(d.config.RUNS_STREAM, "-", "+");
    expect(entries.map(([, f]) => f[1])).toContain(id);
    // Nothing goes to the submissions stream or table.
    expect(await d.queue.redis.xlen(d.config.SUBMISSIONS_STREAM)).toBe(0);

    expect((await post(alice, ok)).status).toBe(409); // still queued
    expect((await post(bob, ok)).status).toBe(202); // other users are independent
    await d.queue.redis.hset(key(id), "status", "done");
    expect((await post(alice, ok)).status).toBe(202); // finished: a new run is fine
  });

  it("GET /runs/:id returns the result to its owner only", async () => {
    // Bob's run from the previous test (still queued).
    const id = (await d.queue.redis.get(`${d.config.RUN_KEY_PREFIX}active:${bob.userId}`))!;
    const result = { status: "OK", stdout: "5\n", stderr: "", exit_code: 0, cpu_ms: 3, wall_ms: 4, max_rss_kb: 900, stdout_truncated: false };
    await d.queue.redis.hset(key(id), "status", "done", "result", JSON.stringify(result));
    const mine = await request(app).get(`/runs/${id}`).set("Cookie", bob.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ id, status: "done", result });
    expect(mine.headers["cache-control"]).toContain("no-store");
    expect((await request(app).get(`/runs/${id}`).set("Cookie", alice.cookie)).status).toBe(404);
    expect((await request(app).get(`/runs/${id}`)).status).toBe(401);
    expect((await request(app).get(`/runs/not-a-uuid`).set("Cookie", bob.cookie)).status).toBe(400);
    expect((await request(app).get(`/runs/00000000-0000-4000-8000-000000000000`).set("Cookie", bob.cookie)).status).toBe(404);
  });
});

describe("run rate limit", () => {
  it("is separate from submissions and answers 429 with Retry-After", async () => {
    const lim = testDeps({ RUN_LIMIT_PER_MIN: "2" });
    const limApp = createApp(lim);
    const u = await createTestUser(lim.db);
    try {
      const run = () => request(limApp).post("/runs").set("Origin", ORIGIN).set("Cookie", u.cookie).send({ ...ok, language: "rust" });
      expect((await run()).status).toBe(400);
      expect((await run()).status).toBe(400);
      const third = await run();
      expect(third.status).toBe(429);
      expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
      // Submissions still have their own budget.
      const sub = await request(limApp).post("/submissions").set("Origin", ORIGIN).set("Cookie", u.cookie).send({ problemSlug: "ledger-total", language: "rust", source: "x" });
      expect(sub.status).toBe(400);
    } finally {
      await deleteTestUsers(lim.db, [u.userId]);
      await lim.close();
    }
  });
});
