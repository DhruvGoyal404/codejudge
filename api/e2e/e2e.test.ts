// End-to-end and resilience tests: real API (in-process), real judge-worker
// processes, real sandbox containers, compose Postgres + Valkey.
//
//   npm run e2e        (never alongside the benchmark or other suites)
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { devEnv } from "../test/helpers.ts";
import { containersOf, prepare, startStack, waitFor, type Stack } from "./harness.ts";

const SLUGS = ["ledger-total", "range-ledger", "courier-grid", "rising-towers", "farthest-beacons"];

beforeAll(() => {
  prepare(devEnv());
});

async function finalOf(s: Stack, id: string) {
  const r = await s.d.db.pool.query(
    `SELECT status, verdict, attempt, worker_id, (SELECT count(*)::int FROM submission_tests t WHERE t.submission_id = s.id) AS tests
       FROM submissions s WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

describe("verdicts through the API (2 workers)", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
    s.startWorker(`e2e-${s.run}-w1`);
    s.startWorker(`e2e-${s.run}-w2`);
  });
  afterAll(async () => s.close());

  it("AC / WA / TLE references for every seed problem end with the right SSE verdict", async () => {
    const cases = SLUGS.flatMap((slug) => [
      { slug, file: "ref.cpp", want: "AC" },
      { slug, file: "wrong.cpp", want: "WA" },
      { slug, file: "slow.cpp", want: "TLE" },
    ]);
    const results = await Promise.all(
      cases.map(async (c) => {
        const id = await s.submit(c.slug, c.file);
        const events = await s.sse(id);
        return { ...c, id, events };
      }),
    );
    for (const r of results) {
      const verdicts = r.events.filter((e) => e.event === "verdict");
      expect(verdicts, `${r.slug}/${r.file}`).toHaveLength(1);
      expect(verdicts[0]!.data.verdict, `${r.slug}/${r.file}`).toBe(r.want);
      expect(r.events[0]!.event).toBe("status"); // current state first
    }
    // Live progress reached the client for every submission. A subscriber
    // that connects after compilation starts gets the latest stage replayed,
    // so "compiling" is only guaranteed when it connected early enough.
    for (const r of results) {
      const progress = r.events.filter((e) => e.event === "progress");
      expect(progress.length, `${r.slug}/${r.file}`).toBeGreaterThan(0);
      for (const p of progress) {
        expect(["compiling", "testing"]).toContain(p.data.stage);
        expect(p.data.total).toBeGreaterThan(0);
      }
    }
    const allStages = new Set(results.flatMap((r) => r.events.filter((e) => e.event === "progress").map((e) => e.data.stage)));
    expect([...allStages].sort()).toEqual(["compiling", "testing"]);
    // range-ledger/wrong.cpp fails on sample 01: its stdout is stored for that
    // sample; hidden tests never carry output.
    const wrong = results.find((r) => r.slug === "range-ledger" && r.file === "wrong.cpp")!;
    const sub = (await (await fetch(`${s.base}/submissions/${wrong.id}`)).json()) as any;
    expect(sub).toMatchObject({ verdict: "WA", failed_test: "01", failed_is_sample: true });
    expect(sub.tests[0]).toMatchObject({ name: "01", is_sample: true, status: "WA", stdout: "14\n7\n0\n", stdout_truncated: false });
    const ac = results.find((r) => r.slug === "ledger-total" && r.file === "ref.cpp")!;
    const acSub = (await (await fetch(`${s.base}/submissions/${ac.id}`)).json()) as any;
    for (const tr of acSub.tests) {
      if (tr.is_sample) expect(typeof tr.stdout).toBe("string");
      else expect(tr).not.toHaveProperty("stdout");
    }
    const leaked = await s.d.db.pool.query(
      `SELECT count(*)::int AS n FROM submission_tests WHERE submission_id = ANY($1::uuid[]) AND NOT is_sample AND stdout IS NOT NULL`,
      [results.map((r) => r.id)],
    );
    expect(leaked.rows[0].n).toBe(0);
  }, 900_000);
});

describe("load: 30 concurrent submissions, 2 workers", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
    s.startWorker(`e2e-${s.run}-w1`);
    s.startWorker(`e2e-${s.run}-w2`);
  });
  afterAll(async () => s.close());

  it("all complete with exactly one final verdict and no duplicate test rows", async () => {
    const plan = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? { slug: "ledger-total", file: "ref.py", want: "AC" } :
      i % 3 === 1 ? { slug: "rising-towers", file: "ref.cpp", want: "AC" } :
                    { slug: "range-ledger", file: "wrong.cpp", want: "WA" },
    );
    const ids = await Promise.all(plan.map((p) => s.submit(p.slug, p.file)));
    const streams = await Promise.all(ids.map((id) => s.sse(id, 900_000)));

    for (const [i, id] of ids.entries()) {
      const verdicts = streams[i]!.filter((e) => e.event === "verdict");
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.data.verdict).toBe(plan[i]!.want);
      const row = await finalOf(s, id);
      expect(row.status).toBe("done");
      expect(row.attempt).toBe(1); // nobody needed a retry
    }
    // Exactly one "done" event per submission on judge:events.
    const entries = await s.d.queue.redis.xrange(s.d.config.EVENTS_STREAM, "-", "+");
    const done = new Map<string, number>();
    for (const [, f] of entries) {
      const o = Object.fromEntries(Array.from({ length: f.length / 2 }, (_, k) => [f[2 * k], f[2 * k + 1]]));
      if (o.status === "done") done.set(o.id!, (done.get(o.id!) ?? 0) + 1);
    }
    for (const id of ids) expect(done.get(id), id).toBe(1);
    // No duplicate stream entries: the sweeper (original 60 s threshold) never
    // re-enqueued a submission that was waiting in the backlog.
    expect(await s.d.queue.redis.xlen(s.d.config.SUBMISSIONS_STREAM)).toBe(ids.length);
    const streamed = (await s.d.queue.redis.xrange(s.d.config.SUBMISSIONS_STREAM, "-", "+")).map(([, f]) => f[1]!);
    expect(streamed.sort()).toEqual([...ids].sort());
    // No duplicate submission_tests rows (also guaranteed by the PK).
    const dup = await s.d.db.pool.query(
      `SELECT submission_id, seq, count(*) FROM submission_tests WHERE submission_id = ANY($1::uuid[]) GROUP BY 1, 2 HAVING count(*) > 1`,
      [ids],
    );
    expect(dup.rowCount).toBe(0);
    // Both workers took part.
    const by = await s.d.db.pool.query(`SELECT count(DISTINCT worker_id)::int AS n FROM submissions WHERE id = ANY($1::uuid[])`, [ids]);
    expect(by.rows[0].n).toBe(2);
  }, 900_000);
});

describe("crash recovery", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(async () => s.close());

  it("a killed worker's submission is reclaimed via XAUTOCLAIM and finished; its container is reaped", async () => {
    const fast = { JUDGE_CLAIM_IDLE: "15s", JUDGE_HEARTBEAT: "3s", JUDGE_CONCURRENCY: "1" };
    const a = `e2e-${s.run}-dying`;
    const b = `e2e-${s.run}-rescuer`;
    s.startWorker(a, fast);
    const id = await s.submit("farthest-beacons", "ref.py"); // several seconds of judging
    // Wait until A is mid-judging: claimed in the DB and its sandbox container exists.
    await waitFor(async () => {
      const r = await finalOf(s, id);
      return r.status === "running" && r.worker_id === a && containersOf(a).length > 0;
    }, 120_000, 100);
    s.killWorker(a); // hard kill: no graceful shutdown, entry stays pending, container orphaned
    const before = await finalOf(s, id);
    expect(before.status).toBe("running");

    s.startWorker(b, fast); // startup + periodic reaper, XAUTOCLAIM after 15 s idle
    const events = await s.sse(id, 300_000);
    expect(events.at(-1)).toMatchObject({ event: "verdict", data: { verdict: "AC" } });
    const after = await finalOf(s, id);
    expect(after).toMatchObject({ status: "done", verdict: "AC", attempt: 2, worker_id: b });
    await waitFor(async () => containersOf(a).length === 0, 120_000, 1000);
  }, 600_000);
});

describe("outbox sweeper", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ sweepAfterMs: 2_000 });
    s.startWorker(`e2e-${s.run}-w1`);
  });
  afterAll(async () => s.close());

  const AC_CPP = `#include <cstdio>\nint main(){int n;long long s=0,x;scanf("%d",&n);while(n--){scanf("%lld",&x);s+=x;}printf("%lld\\n",s);}`;
  let doneId = "";

  it("a queued submission that was never XADDed is enqueued by the sweeper and completes", async () => {
    const r = await s.d.db.pool.query(
      `INSERT INTO submissions (problem_id, language, source)
       SELECT id, 'cpp', $1 FROM problems WHERE slug = 'ledger-total' RETURNING id`,
      [AC_CPP],
    );
    const id = r.rows[0].id as string;
    s.created.push(id);
    const events = await s.sse(id, 300_000);
    expect(events.at(-1)).toMatchObject({ event: "verdict", data: { verdict: "AC" } });
    const row = await s.d.db.pool.query(`SELECT enqueued_at, stream_entry_id, attempt FROM submissions WHERE id = $1`, [id]);
    expect(row.rows[0].enqueued_at).not.toBeNull(); // stamped by the sweeper, not the API
    expect(row.rows[0].stream_entry_id).toMatch(/^\d+-\d+$/);
    expect(row.rows[0].attempt).toBe(1);
    doneId = id;
  }, 400_000);

  it("a queued submission whose stream entry was lost is re-enqueued and completes", async () => {
    const r = await s.d.db.pool.query(
      `INSERT INTO submissions (problem_id, language, source, created_at, enqueued_at, stream_entry_id)
       SELECT id, 'cpp', $1, now() - interval '1 hour', now() - interval '1 hour', '1-1'
         FROM problems WHERE slug = 'ledger-total' RETURNING id`,
      [AC_CPP],
    );
    const id = r.rows[0].id as string;
    s.created.push(id);
    const events = await s.sse(id, 300_000);
    expect(events.at(-1)).toMatchObject({ event: "verdict", data: { verdict: "AC" } });
    const row = await s.d.db.pool.query(`SELECT stream_entry_id, attempt FROM submissions WHERE id = $1`, [id]);
    expect(row.rows[0].stream_entry_id).not.toBe("1-1");
    expect(row.rows[0].attempt).toBe(1);
  }, 400_000);

  it("a duplicate delivery of a done submission is XACKed without judging", async () => {
    const before = await finalOf(s, doneId);
    const dup = await s.d.queue.redis.xadd(s.d.config.SUBMISSIONS_STREAM, "*", "id", doneId);
    // Delivered (past the group's last-delivered id) and acknowledged (not pending).
    await waitFor(
      async () => {
        const groups = (await s.d.queue.redis.xinfo("GROUPS", s.d.config.SUBMISSIONS_STREAM)) as unknown[][];
        const g = groups.map((x) => Object.fromEntries(Array.from({ length: x.length / 2 }, (_, k) => [x[2 * k], x[2 * k + 1]])));
        const delivered = g.some((x) => x["last-delivered-id"] === dup);
        const pending = (await s.d.queue.redis.xpending(s.d.config.SUBMISSIONS_STREAM, "workers")) as [number, ...unknown[]];
        return delivered && pending[0] === 0;
      },
      60_000,
      500,
    );
    expect(await finalOf(s, doneId)).toEqual(before); // same attempt, verdict, worker, test rows
  }, 120_000);
});

describe("sweeper: stuck running submission", () => {
  let s: Stack;
  beforeAll(async () => {
    // runningAfterMs must exceed the judging time, or the sweeper would
    // re-enqueue the re-claimed attempt too (fencing would still pick one
    // result, but attempt would be 3). Production default: 30 min.
    s = await startStack({ sweepAfterMs: 2_000, runningAfterMs: 60_000 });
    s.startWorker(`e2e-${s.run}-w1`);
  });
  afterAll(async () => s.close());

  it("a running submission with an old started_at and no stream entry completes", async () => {
    const source = (await import("node:fs")).readFileSync(
      (await import("node:path")).join((await import("./harness.ts")).PROBLEMS, "ledger-total", "solutions", "ref.cpp"),
      "utf8",
    );
    const r = await s.d.db.pool.query(
      `INSERT INTO submissions (problem_id, language, source, status, attempt, worker_id, created_at, started_at, enqueued_at)
       SELECT id, 'cpp', $1, 'running', 1, 'lost-worker', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour'
         FROM problems WHERE slug = 'ledger-total' RETURNING id`,
      [source],
    );
    const id = r.rows[0].id as string;
    s.created.push(id);
    const events = await s.sse(id, 300_000);
    expect(events.at(-1)).toMatchObject({ event: "verdict", data: { verdict: "AC" } });
    const row = await s.d.db.pool.query(`SELECT attempt, worker_id FROM submissions WHERE id = $1`, [id]);
    expect(row.rows[0].attempt).toBe(2); // the lost attempt 1 is fenced out
    expect(row.rows[0].worker_id).toBe(`e2e-${s.run}-w1`);
  }, 400_000);
});

describe("latency (small problem, idle system)", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
    s.startWorker(`e2e-${s.run}-w1`);
  });
  afterAll(async () => s.close());

  it("POST -> final SSE verdict, ledger-total ref.cpp, 20 sequential runs", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const id = await s.submit("ledger-total", "ref.cpp");
      const events = await s.sse(id);
      samples.push(performance.now() - t0);
      expect(events.at(-1)!.data.verdict).toBe("AC");
    }
    samples.sort((x, y) => x - y);
    const p = (q: number) => Math.round(samples[Math.round(q * (samples.length - 1))]!);
    const line = `LATENCY ledger-total ref.cpp end-to-end: p50=${p(0.5)}ms p95=${p(0.95)}ms min=${p(0)}ms max=${p(1)}ms (n=20) at ${new Date().toISOString()}`;
    console.log(line);
    appendFileSync(join(tmpdir(), "codejudge-latency.txt"), `${line}\n`);
  }, 900_000);
});
