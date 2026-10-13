import type { AddressInfo } from "node:net";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, MAX_SOURCE_BYTES, sweepOnce } from "../src/app.ts";
import { EventConsumer } from "../src/events.ts";
import { createTestUser, deleteTestUsers, ORIGIN, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

let d: TestDeps;
let app: ReturnType<typeof createApp>;
let user: TestUser;
const others: number[] = [];
const created: string[] = [];
/** Authenticated, same-origin POST. */
const post = (path: string) => request(app).post(path).set("Origin", ORIGIN).set("Cookie", user.cookie);

beforeAll(async () => {
  d = testDeps();
  app = createApp(d);
  user = await createTestUser(d.db);
  const n = await d.db.pool.query(`SELECT count(*)::int AS n FROM problems WHERE slug = 'ledger-total'`);
  if (n.rows[0].n !== 1) throw new Error("seed problems missing: run `judge-admin import problems/` first");
});

afterAll(async () => {
  if (created.length) await d.db.pool.query(`DELETE FROM submissions WHERE id = ANY($1::uuid[])`, [created]);
  await deleteTestUsers(d.db, [user.userId, ...others]);
  await d.close();
});

async function streamIds(stream: string): Promise<string[]> {
  const entries = await d.queue.redis.xrange(stream, "-", "+");
  return entries.map(([, fields]) => fields[fields.indexOf("id") + 1]!);
}

const entryOf = async (id: string) =>
  (await d.db.pool.query(`SELECT stream_entry_id FROM submissions WHERE id = $1`, [id])).rows[0].stream_entry_id as string | null;

async function insertRaw(status: string, verdict: string | null, ageSeconds: number, enqueuedAgeSeconds: number | null) {
  const r = await d.db.pool.query(
    `INSERT INTO submissions (problem_id, language, source, status, verdict, created_at, enqueued_at, finished_at)
     SELECT id, 'cpp', 'int main(){}', $1, $2, now() - make_interval(secs => $3),
            CASE WHEN $4::double precision IS NULL THEN NULL ELSE now() - make_interval(secs => $4) END,
            CASE WHEN $1 = 'done' THEN now() END
       FROM problems WHERE slug = 'ledger-total' RETURNING id`,
    [status, verdict, ageSeconds, enqueuedAgeSeconds],
  );
  const id = r.rows[0].id as string;
  created.push(id);
  return id;
}

describe("health and problems", () => {
  it("GET /health reports both dependencies", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, postgres: true, valkey: true });
  });

  it("GET /problems lists the seed problems", async () => {
    const r = await request(app).get("/problems");
    expect(r.status).toBe(200);
    const slugs = r.body.problems.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining(["courier-grid", "farthest-beacons", "ledger-total", "range-ledger", "rising-towers"]));
  });

  it("GET /problems/:slug returns statement and samples only", async () => {
    const r = await request(app).get("/problems/ledger-total");
    expect(r.status).toBe(200);
    expect(r.body.statement_md).toContain("Ledger Total");
    expect(r.body.samples.map((s: { name: string }) => s.name)).toEqual(["01", "02"]);
    expect(r.body).not.toHaveProperty("id");
    // Only the public samples are returned.
    expect(r.body.samples).toHaveLength(2);
  });

  it("rejects bad and unknown slugs", async () => {
    expect((await request(app).get("/problems/Bad_Slug!")).status).toBe(400);
    expect((await request(app).get("/problems/no-such-problem")).status).toBe(404);
  });
});

describe("POST /submissions", () => {
  it("inserts a queued submission and enqueues it", async () => {
    const r = await post("/submissions").send({ problemSlug: "ledger-total", language: "cpp", source: "int main(){}" });
    expect(r.status).toBe(202);
    expect(r.headers.location).toBe(`/submissions/${r.body.id}`);
    created.push(r.body.id);
    expect(await streamIds(d.config.SUBMISSIONS_STREAM)).toContain(r.body.id);
    const row = await d.db.pool.query(`SELECT status, enqueued_at, user_id FROM submissions WHERE id = $1`, [r.body.id]);
    expect(row.rows[0].status).toBe("queued");
    expect(Number(row.rows[0].user_id)).toBe(user.userId);
    expect(row.rows[0].enqueued_at).not.toBeNull();
    // The XADD entry id is recorded.
    const entries = await d.queue.redis.xrange(d.config.SUBMISSIONS_STREAM, "-", "+");
    expect(entries.find(([, f]) => f[1] === r.body.id)?.[0]).toBe(await entryOf(r.body.id));
  });

  it("validates the body", async () => {
    const submit = (body: unknown) => post("/submissions").send(body as object);
    expect((await submit({ problemSlug: "ledger-total", language: "rust", source: "x" })).status).toBe(400);
    expect((await submit({ problemSlug: "ledger-total", language: "cpp", source: "" })).status).toBe(400);
    expect((await submit({ problemSlug: "ledger-total", language: "cpp", source: "x", extra: 1 })).status).toBe(400);
    expect((await submit({ problemSlug: "no-such-problem", language: "cpp", source: "x" })).status).toBe(404);
    const big = "a".repeat(MAX_SOURCE_BYTES + 1);
    expect((await submit({ problemSlug: "ledger-total", language: "cpp", source: big })).status).toBe(413);
    // multi-byte characters count in bytes, not characters
    const bigUtf8 = "é".repeat(MAX_SOURCE_BYTES / 2 + 1);
    expect((await submit({ problemSlug: "ledger-total", language: "python", source: bigUtf8 })).status).toBe(413);
    const malformed = await post("/submissions").set("Content-Type", "application/json").send("{nope");
    expect(malformed.status).toBe(400);
  });

  it("accepts a source of exactly the limit", async () => {
    const r = await post("/submissions").send({ problemSlug: "ledger-total", language: "cpp", source: "a".repeat(MAX_SOURCE_BYTES) });
    expect(r.status).toBe(202);
    created.push(r.body.id);
  });
});

describe("GET /submissions/:id", () => {
  it("returns the submission without source", async () => {
    const id = await insertRaw("done", "AC", 0, 0);
    const r = await request(app).get(`/submissions/${id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, problem_slug: "ledger-total", status: "done", verdict: "AC", tests: [] });
    expect(r.body).not.toHaveProperty("source");
  });

  it("rejects bad and unknown ids", async () => {
    expect((await request(app).get("/submissions/not-a-uuid")).status).toBe(400);
    expect((await request(app).get("/submissions/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("sweeper (simplified transactional outbox)", () => {
  it("re-enqueues a stale queued submission exactly once per window", async () => {
    const sweepCfg = { ...d, config: { ...d.config, SWEEP_AFTER_MS: 60_000 } };
    const stale = await insertRaw("queued", null, 120, null); // inserted, XADD never happened
    const fresh = await insertRaw("queued", null, 5, null); // too young to sweep
    const recent = await insertRaw("queued", null, 120, 10); // re-enqueued 10 s ago
    await sweepOnce(sweepCfg);
    const ids = await streamIds(d.config.SUBMISSIONS_STREAM);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(recent);
    // A second sweep right away does not re-add it: enqueued_at was stamped.
    await sweepOnce(sweepCfg);
    expect((await streamIds(d.config.SUBMISSIONS_STREAM)).filter((x) => x === stale)).toHaveLength(1);
    expect(await entryOf(stale)).toMatch(/^\d+-\d+$/);
  });

  it("does not re-enqueue a submission still waiting in the stream (backlog), however old", async () => {
    const sweepCfg = { ...d, config: { ...d.config, SWEEP_AFTER_MS: 60_000 } };
    const other = await createTestUser(d.db); // `user` is at the active cap by now
    others.push(other.userId);
    const r = await request(app).post("/submissions").set("Origin", ORIGIN).set("Cookie", other.cookie).send({ problemSlug: "ledger-total", language: "cpp", source: "int main(){}" });
    created.push(r.body.id);
    // Waited 10 minutes in a backlog; its entry is still in the stream.
    await d.db.pool.query(
      `UPDATE submissions SET created_at = now() - interval '10 minutes', enqueued_at = now() - interval '10 minutes' WHERE id = $1`,
      [r.body.id],
    );
    const entry = await entryOf(r.body.id);
    expect(await sweepOnce(sweepCfg)).toBe(0);
    expect((await streamIds(d.config.SUBMISSIONS_STREAM)).filter((x) => x === r.body.id)).toHaveLength(1);
    expect(await entryOf(r.body.id)).toBe(entry);
  });

  it("re-enqueues a queued submission whose stream entry is gone, recording the new entry", async () => {
    const sweepCfg = { ...d, config: { ...d.config, SWEEP_AFTER_MS: 60_000 } };
    const lost = await insertRaw("queued", null, 120, 120);
    await d.db.pool.query(`UPDATE submissions SET stream_entry_id = '1-1' WHERE id = $1`, [lost]); // trimmed / stream lost
    await sweepOnce(sweepCfg);
    const mine = (await d.queue.redis.xrange(d.config.SUBMISSIONS_STREAM, "-", "+")).filter(([, f]) => f[1] === lost);
    expect(mine).toHaveLength(1);
    expect(await entryOf(lost)).toBe(mine[0]![0]);
  });
});

describe("sweeper: stuck running submissions", () => {
  it("re-enqueues running submissions whose started_at is older than the running threshold", async () => {
    const cfg = { ...d, config: { ...d.config, SWEEP_AFTER_MS: 60_000, SWEEP_RUNNING_AFTER_MS: 30 * 60_000 } };
    const mk = async (startedAgoS: number) => {
      const r = await d.db.pool.query(
        `INSERT INTO submissions (problem_id, language, source, status, attempt, worker_id, created_at, started_at, enqueued_at)
         SELECT id, 'cpp', 'int main(){}', 'running', 1, 'gone-worker', now() - interval '3 hours',
                now() - make_interval(secs => $1), now() - interval '3 hours'
           FROM problems WHERE slug = 'ledger-total' RETURNING id`,
        [startedAgoS],
      );
      created.push(r.rows[0].id);
      return r.rows[0].id as string;
    };
    const stuck = await mk(2 * 3600); // started 2 h ago, worker and stream entry lost
    const active = await mk(60); // a worker started it a minute ago
    await sweepOnce(cfg);
    const ids = await streamIds(d.config.SUBMISSIONS_STREAM);
    expect(ids).toContain(stuck);
    expect(ids).not.toContain(active);
  });
});

describe("sample output only", () => {
  it("stores stdout for sample rows only and never returns output fields for hidden tests", async () => {
    const id = await insertRaw("done", "WA", 0, 0);
    await d.db.pool.query(
      `INSERT INTO submission_tests (submission_id, seq, name, is_sample, status, cpu_ms, rss_kb, stdout, stdout_truncated)
       VALUES ($1, 1, '01', true, 'AC', 1, 100, '12', false),
              ($1, 2, '02', true, 'WA', 1, 100, 'oops', false),
              ($1, 3, '03', false, 'WA', 1, 100, NULL, false)`,
      [id],
    );
    // The schema refuses to store output of a hidden test at all.
    await expect(
      d.db.pool.query(
        `INSERT INTO submission_tests (submission_id, seq, name, is_sample, status, cpu_ms, rss_kb, stdout)
         VALUES ($1, 4, '04', false, 'WA', 1, 100, 'leak')`,
        [id],
      ),
    ).rejects.toThrow(/submission_tests_stdout_samples_only/);
    const r = await request(app).get(`/submissions/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.tests[1]).toMatchObject({ name: "02", is_sample: true, stdout: "oops", stdout_truncated: false });
    expect(r.body.tests[2]).toEqual({ seq: 3, name: "03", is_sample: false, status: "WA", cpu_ms: 1, rss_kb: 100 });
  });
});

describe("GET /submissions/:id/events (SSE)", () => {
  async function listen() {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function readEvents(url: string, onOpen?: () => Promise<void>) {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let opened = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (!opened && onOpen) {
        opened = true;
        await onOpen();
      }
    }
    return buf
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => {
        const [ev, data] = b.split("\n");
        return { event: ev!.slice(7), data: JSON.parse(data!.slice(6)) };
      });
  }

  it("sends current state + verdict and closes for a finished submission", async () => {
    const { server, base } = await listen();
    try {
      const id = await insertRaw("done", "WA", 0, 0);
      const events = await readEvents(`${base}/submissions/${id}/events`);
      expect(events.map((e) => e.event)).toEqual(["status", "verdict"]);
      expect(events[1]!.data).toMatchObject({ id, status: "done", verdict: "WA" });
    } finally {
      server.close();
    }
  });

  it("streams status changes until the verdict", async () => {
    const { server, base } = await listen();
    try {
      const id = await insertRaw("queued", null, 0, 0);
      const events = await readEvents(`${base}/submissions/${id}/events`, async () => {
        await d.db.pool.query(`UPDATE submissions SET status = 'running', attempt = 1 WHERE id = $1`, [id]);
        d.hub.publish(id);
        await new Promise((r) => setTimeout(r, 100));
        await d.db.pool.query(`UPDATE submissions SET status = 'done', verdict = 'AC', finished_at = now() WHERE id = $1`, [id]);
        d.hub.publish(id);
      });
      expect(events.map((e) => `${e.event}:${e.data.status}`)).toEqual(["status:queued", "status:running", "status:done", "verdict:done"]);
      expect(d.hub.size).toBe(0); // listener removed on close
    } finally {
      server.close();
    }
  });

  it("fans out judge:events entries to SSE via the event consumer", async () => {
    const consumer = new EventConsumer(d.config.CODEJUDGE_VALKEY_URL, d.config.EVENTS_STREAM, d.hub, d.log, 500);
    consumer.start();
    const { server, base } = await listen();
    try {
      const id = await insertRaw("queued", null, 0, 0);
      await new Promise((r) => setTimeout(r, 300)); // consumer is tailing from "$"
      const t0 = Date.now();
      const events = await readEvents(`${base}/submissions/${id}/events`, async () => {
        // What a worker does: update the row, then XADD an event.
        await d.db.pool.query(`UPDATE submissions SET status = 'done', verdict = 'TLE', attempt = 1, finished_at = now() WHERE id = $1`, [id]);
        await d.queue.redis.xadd(d.config.EVENTS_STREAM, "*", "id", id, "status", "done", "verdict", "TLE");
      });
      expect(events.at(-1)).toMatchObject({ event: "verdict", data: { id, verdict: "TLE" } });
      // Delivered by the event, well before the 5 s safety poll.
      expect(Date.now() - t0).toBeLessThan(d.config.SSE_POLL_MS);
    } finally {
      server.close();
      await consumer.stop();
    }
  });

  it("forwards progress events (stage, test k of n) without a DB read", async () => {
    const consumer = new EventConsumer(d.config.CODEJUDGE_VALKEY_URL, d.config.EVENTS_STREAM, d.hub, d.log, 500);
    consumer.start();
    const { server, base } = await listen();
    try {
      const id = await insertRaw("queued", null, 0, 0);
      await new Promise((r) => setTimeout(r, 300));
      const events = await readEvents(`${base}/submissions/${id}/events`, async () => {
        const x = (f: string[]) => d.queue.redis.xadd(d.config.EVENTS_STREAM, "*", ...f);
        await d.db.pool.query(`UPDATE submissions SET status = 'running', attempt = 1 WHERE id = $1`, [id]);
        await x(["id", id, "status", "running"]);
        await x(["id", id, "status", "running", "stage", "compiling", "test", "0", "total", "11"]);
        await x(["id", id, "status", "running", "stage", "testing", "test", "3", "total", "11"]);
        await new Promise((r) => setTimeout(r, 300));
        await d.db.pool.query(`UPDATE submissions SET status = 'done', verdict = 'AC', finished_at = now() WHERE id = $1`, [id]);
        await x(["id", id, "status", "done", "verdict", "AC"]);
      });
      const progress = events.filter((e) => e.event === "progress").map((e) => e.data);
      expect(progress).toEqual([
        { id, stage: "compiling", test: 0, total: 11 },
        { id, stage: "testing", test: 3, total: 11 },
      ]);
      expect(events.at(-1)).toMatchObject({ event: "verdict", data: { verdict: "AC" } });
    } finally {
      server.close();
      await consumer.stop();
    }
  });

  it("replays the latest progress to a subscriber that connects mid-judging", async () => {
    const { server, base } = await listen();
    try {
      const id = await insertRaw("queued", null, 0, 0);
      await d.db.pool.query(`UPDATE submissions SET status = 'running', attempt = 1 WHERE id = $1`, [id]);
      d.hub.publish(id, { id, status: "running", stage: "testing", test: "7", total: "11" });
      const events = await readEvents(`${base}/submissions/${id}/events`, async () => {
        await d.db.pool.query(`UPDATE submissions SET status = 'done', verdict = 'AC', finished_at = now() WHERE id = $1`, [id]);
        d.hub.publish(id, { id, status: "done", verdict: "AC" });
      });
      expect(events.map((e) => e.event)).toEqual(["status", "progress", "status", "verdict"]);
      expect(events[1]!.data).toEqual({ id, stage: "testing", test: 7, total: 11 });
      expect(d.hub.latestProgress(id)).toBeUndefined(); // dropped once done
    } finally {
      server.close();
    }
  });

  it("404s for unknown submissions", async () => {
    expect((await request(app).get("/submissions/00000000-0000-4000-8000-000000000000/events")).status).toBe(404);
  });
});
