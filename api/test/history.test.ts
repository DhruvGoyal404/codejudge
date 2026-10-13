import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { createTestUser, deleteTestUsers, ORIGIN, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

let d: TestDeps;
let app: ReturnType<typeof createApp>;
const users: number[] = [];

beforeAll(async () => {
  d = testDeps();
  app = createApp(d);
  if (d.queue.redis.status !== "ready") await new Promise((r) => d.queue.redis.once("ready", r));
});

afterAll(async () => {
  await deleteTestUsers(d.db, users);
  await d.close();
});

async function newUser(): Promise<TestUser> {
  const u = await createTestUser(d.db);
  users.push(u.userId);
  return u;
}

/**
 * Inserts a finished submission for u directly. `at` is a Postgres timestamp
 * expression so tests can create exact ties and microsecond differences.
 */
async function insertDone(u: TestUser, slug: string, verdict: string, at: string, source = "int main(){}") {
  const r = await d.db.pool.query(
    `INSERT INTO submissions (problem_id, language, source, status, verdict, created_at, finished_at, user_id)
     SELECT id, 'cpp', $3, 'done', $2, ${at}, ${at}, $4 FROM problems WHERE slug = $1 RETURNING id`,
    [slug, verdict, source, u.userId],
  );
  return r.rows[0].id as string;
}

const history = (u: TestUser | null, qs = "") => {
  const req = request(app).get(`/me/submissions${qs}`);
  return u ? req.set("Cookie", u.cookie) : req;
};

/** Follows next_cursor to the end; returns ids in order. */
async function allPages(u: TestUser, filters: string, limit: number) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const r = await history(u, `?limit=${limit}${filters}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(r.status).toBe(200);
    expect(r.body.submissions.length).toBeLessThanOrEqual(limit);
    ids.push(...r.body.submissions.map((s: { id: string }) => s.id));
    cursor = r.body.next_cursor;
    if (!cursor) return ids;
  }
  throw new Error("pagination did not terminate");
}

describe("GET /me/submissions", () => {
  let u: TestUser;
  let expected: string[]; // newest first, by (created_at DESC, id DESC)

  beforeAll(async () => {
    u = await newUser();
    // 23 rows: distinct times, 4-way ties at one timestamp, and rows 1 µs apart.
    for (let i = 0; i < 15; i++) {
      await insertDone(u, i % 2 ? "ledger-total" : "range-ledger", i % 3 ? "WA" : "AC", `now() - interval '${i + 10} minutes'`);
    }
    for (let i = 0; i < 4; i++) await insertDone(u, "ledger-total", "AC", `'2026-01-01 12:00:00.123456+00'::timestamptz`);
    for (let i = 0; i < 4; i++) await insertDone(u, "courier-grid", "TLE", `'2026-01-01 11:00:00.000001+00'::timestamptz + interval '${i} microseconds'`);
    const r = await d.db.pool.query(`SELECT id FROM submissions WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [u.userId]);
    expected = r.rows.map((x) => x.id);
    expect(expected).toHaveLength(23);
  });

  it("401 when logged out", async () => {
    expect((await history(null)).status).toBe(401);
  });

  it("returns the summary fields, newest first, without source", async () => {
    const r = await history(u, "?limit=3");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.body.submissions.map((s: { id: string }) => s.id)).toEqual(expected.slice(0, 3));
    expect(Object.keys(r.body.submissions[0]).sort()).toEqual(
      ["created_at", "finished_at", "id", "language", "max_cpu_ms", "max_rss_kb", "problem_slug", "problem_title", "status", "verdict"].sort(),
    );
    expect(typeof r.body.next_cursor).toBe("string");
  });

  it.each([1, 4, 5, 10, 23, 100])("pages of %i cover every row exactly once, in order (ties and µs)", async (limit) => {
    expect(await allPages(u, "", limit)).toEqual(expected);
  });

  it("the last page has next_cursor null; an exact multiple doesn't produce an empty extra page", async () => {
    const r = await history(u, "?limit=23");
    expect(r.body.submissions).toHaveLength(23);
    expect(r.body.next_cursor).toBeNull();
  });

  it("filters by problem, verdict, and both (with pagination)", async () => {
    const rows = await d.db.pool.query(
      `SELECT s.id, p.slug, s.verdict FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = $1 ORDER BY s.created_at DESC, s.id DESC`,
      [u.userId],
    );
    const want = (f: (x: { slug: string; verdict: string }) => boolean) => rows.rows.filter(f).map((x) => x.id);
    expect(await allPages(u, "&problem=ledger-total", 3)).toEqual(want((x) => x.slug === "ledger-total"));
    expect(await allPages(u, "&verdict=AC", 2)).toEqual(want((x) => x.verdict === "AC"));
    expect(await allPages(u, "&problem=ledger-total&verdict=WA", 2)).toEqual(want((x) => x.slug === "ledger-total" && x.verdict === "WA"));
    expect(await allPages(u, "&problem=rising-towers", 5)).toEqual([]);
  });

  it("lists only the caller's submissions", async () => {
    const other = await newUser();
    await insertDone(other, "ledger-total", "AC", "now()");
    const mine = await allPages(u, "", 100);
    const theirs = await allPages(other, "", 100);
    expect(theirs).toHaveLength(1);
    expect(mine).not.toContain(theirs[0]);
  });

  it("rejects bad parameters", async () => {
    for (const qs of ["?verdict=XX", "?problem=Bad_Slug!", "?limit=0", "?limit=101", "?cursor=notbase64json", "?unknown=1", "?verdict=AC&verdict=WA"]) {
      expect((await history(u, qs)).status, qs).toBe(400);
    }
    const forged = Buffer.from(JSON.stringify({ t: "2026-01-01", id: "not-a-uuid" })).toString("base64url");
    expect((await history(u, `?cursor=${forged}`)).status).toBe(400);
  });
});

describe("GET /submissions/:id: source only for its owner", () => {
  it("owner gets source and mine=true; another user and anonymous get neither", async () => {
    const owner = await newUser();
    const other = await newUser();
    const id = await insertDone(owner, "ledger-total", "AC", "now()", "// secret solution\nint main(){}");

    const mine = await request(app).get(`/submissions/${id}`).set("Cookie", owner.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id, mine: true, source: "// secret solution\nint main(){}" });

    for (const r of [await request(app).get(`/submissions/${id}`).set("Cookie", other.cookie), await request(app).get(`/submissions/${id}`)]) {
      expect(r.status).toBe(200);
      expect(r.body.mine).toBe(false);
      expect(r.body).not.toHaveProperty("source");
      expect(JSON.stringify(r.body)).not.toContain("secret solution");
    }
    expect(mine.body).not.toHaveProperty("user_id");
  });

  it("SSE verdict events never carry the source, even for the owner", async () => {
    const owner = await newUser();
    const id = await insertDone(owner, "ledger-total", "AC", "now()", "// secret solution\nint main(){}");
    const r = await request(app).get(`/submissions/${id}/events`).set("Cookie", owner.cookie);
    expect(r.text).toContain("event: verdict");
    expect(r.text).not.toContain("secret solution");
  });
});

describe("solved / attempted badges on GET /problems", () => {
  it("solved = any AC, attempted = submissions without AC, null otherwise; anonymous all null", async () => {
    const u = await newUser();
    await insertDone(u, "ledger-total", "WA", "now() - interval '2 minutes'");
    await insertDone(u, "ledger-total", "AC", "now()");
    await insertDone(u, "range-ledger", "WA", "now()");
    await d.db.pool.query(
      `INSERT INTO submissions (problem_id, language, source, user_id) SELECT id, 'cpp', 'x', $1 FROM problems WHERE slug = 'courier-grid'`,
      [u.userId],
    ); // still queued: counts as attempted

    const status = (r: request.Response) =>
      Object.fromEntries(r.body.problems.map((p: { slug: string; my_status: string | null }) => [p.slug, p.my_status]));
    const r = await request(app).get("/problems").set("Cookie", u.cookie);
    expect(r.status).toBe(200);
    expect(status(r)).toMatchObject({
      "ledger-total": "solved",
      "range-ledger": "attempted",
      "courier-grid": "attempted",
      "rising-towers": null,
      "farthest-beacons": null,
    });
    const anon = await request(app).get("/problems");
    expect(Object.values(status(anon)).every((v) => v === null)).toBe(true);
  });

  it("is computed in a single query", async () => {
    const u = await newUser();
    const spy = vi.spyOn(d.db.pool, "query");
    try {
      await request(app).get("/problems").set("Cookie", u.cookie);
      const problemQueries = spy.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("FROM problems"));
      expect(problemQueries).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST still works for the history owner", () => {
  it("a new submission shows up first in /me/submissions", async () => {
    const u = await newUser();
    const r = await request(app)
      .post("/submissions")
      .set("Origin", ORIGIN)
      .set("Cookie", u.cookie)
      .send({ problemSlug: "ledger-total", language: "python", source: "print(1)" });
    expect(r.status).toBe(202);
    const h = await history(u);
    expect(h.body.submissions[0]).toMatchObject({ id: r.body.id, status: "queued", verdict: null, language: "python", problem_slug: "ledger-total" });
  });
});
