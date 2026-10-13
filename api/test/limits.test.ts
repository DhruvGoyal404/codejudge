import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { createTestUser, deleteTestUsers, ORIGIN, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

// Production limits (6/min and 200/day per user, 20/min per IP on /auth/*),
// with the "minute" shortened to 5 s so the reset is observable. (2 s was
// too short: on a busy machine a burst of requests could outlast the window.)
const WINDOW_S = 5;
let d: TestDeps;
let app: ReturnType<typeof createApp>;
const users: number[] = [];

beforeAll(async () => {
  d = testDeps({
    SUBMIT_LIMIT_PER_MIN: "6",
    SUBMIT_LIMIT_PER_DAY: "200",
    AUTH_LIMIT_PER_MIN: "20",
    RATE_LIMIT_MINUTE_S: String(WINDOW_S),
    TRUST_PROXY: "true", // lets the tests choose the client IP via X-Forwarded-For
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });
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

// An invalid body: counted by the limiter (every attempt is), rejected with
// 400 afterwards, and creates no submission row.
const attempt = (a: typeof app, u: TestUser) =>
  request(a).post("/submissions").set("Origin", ORIGIN).set("Cookie", u.cookie).send({ problemSlug: "ledger-total" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expectLimited(r: request.Response, maxRetryAfter: number) {
  expect(r.status).toBe(429);
  expect(r.body).toEqual({ error: "too many requests" });
  const ra = Number(r.headers["retry-after"]);
  expect(Number.isInteger(ra)).toBe(true);
  expect(ra).toBeGreaterThanOrEqual(1);
  expect(ra).toBeLessThanOrEqual(maxRetryAfter);
}

describe("per-user submission limits", () => {
  it("6 per minute: the 7th attempt is 429 with Retry-After; it resets after the window", async () => {
    const u = await newUser();
    // The window is per key and starts at the first attempt; a fresh user
    // starts a fresh window.
    for (let i = 0; i < 6; i++) expect((await attempt(app, u)).status, `attempt ${i + 1}`).toBe(400);
    expectLimited(await attempt(app, u), WINDOW_S);
    // Other users are unaffected.
    expect((await attempt(app, await newUser())).status).toBe(400);
    // After the window the user can submit again.
    await sleep(WINDOW_S * 1000 + 200);
    expect((await attempt(app, u)).status).toBe(400);
  });

  it("a real submission counts too, and 429 comes before anything is inserted", async () => {
    const u = await newUser();
    const ok = await request(app)
      .post("/submissions")
      .set("Origin", ORIGIN)
      .set("Cookie", u.cookie)
      .send({ problemSlug: "ledger-total", language: "cpp", source: "int main(){}" });
    expect(ok.status).toBe(202);
    for (let i = 0; i < 5; i++) await attempt(app, u);
    const r = await request(app)
      .post("/submissions")
      .set("Origin", ORIGIN)
      .set("Cookie", u.cookie)
      .send({ problemSlug: "ledger-total", language: "cpp", source: "int main(){}" });
    expectLimited(r, WINDOW_S);
    const n = await d.db.pool.query(`SELECT count(*)::int AS n FROM submissions WHERE user_id = $1`, [u.userId]);
    expect(n.rows[0].n).toBe(1);
  });

  it("200 per day: the daily limit trips independently of the minute window", async () => {
    // Same production minute limit, a small daily one so the test is short.
    const daily = testDeps({ SUBMIT_LIMIT_PER_MIN: "6", SUBMIT_LIMIT_PER_DAY: "8", RATE_LIMIT_MINUTE_S: "1" });
    try {
      const a = createApp(daily);
      const u = await newUser();
      let ok = 0;
      for (let round = 0; round < 3 && ok < 8; round++) {
        for (let i = 0; i < 4 && ok < 8; i++) {
          expect((await attempt(a, u)).status).toBe(400);
          ok++;
        }
        await sleep(1100); // next minute window
      }
      const r = await attempt(a, u);
      expect(r.status).toBe(429);
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(24 * 3600 - 60);
    } finally {
      await daily.close();
    }
  });
});

describe("per-IP limit on /auth/*", () => {
  const login = (ip: string) => request(app).get("/auth/github").set("X-Forwarded-For", ip);

  it("20 per minute per IP: the 21st is 429 with Retry-After; other IPs are unaffected; resets", async () => {
    for (let i = 0; i < 20; i++) expect((await login("203.0.113.7")).status, `request ${i + 1}`).toBe(302);
    expectLimited(await login("203.0.113.7"), WINDOW_S);
    // Any /auth path shares the bucket, logout included.
    expectLimited(await request(app).post("/auth/logout").set("Origin", ORIGIN).set("X-Forwarded-For", "203.0.113.7"), WINDOW_S);
    expect((await login("198.51.100.9")).status).toBe(302);
    // Non-auth routes are not limited per IP.
    expect((await request(app).get("/problems").set("X-Forwarded-For", "203.0.113.7")).status).toBe(200);
    await sleep(WINDOW_S * 1000 + 200);
    expect((await login("203.0.113.7")).status).toBe(302);
  });
});

describe("helmet", () => {
  it("sets the standard security headers", async () => {
    const r = await request(app).get("/health");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.headers["strict-transport-security"]).toMatch(/max-age=/);
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
});
