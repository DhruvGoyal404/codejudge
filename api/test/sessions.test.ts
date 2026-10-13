import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { SESSION_RENEW_AFTER_MS, SESSION_TTL_MS } from "../src/sessions.ts";
import { createTestUser, deleteTestUsers, ORIGIN, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

let d: TestDeps;
let app: ReturnType<typeof createApp>;
const users: number[] = [];
const body = { problemSlug: "ledger-total", language: "cpp", source: "int main(){}" };

beforeAll(() => {
  d = testDeps();
  app = createApp(d);
});

afterAll(async () => {
  await deleteTestUsers(d.db, users);
  await d.close();
});

async function newUser(opts?: Parameters<typeof createTestUser>[1]): Promise<TestUser> {
  const u = await createTestUser(d.db, opts);
  users.push(u.userId);
  return u;
}

const sessionRow = async (id: string) =>
  (await d.db.pool.query(`SELECT expires_at, last_seen_at FROM sessions WHERE id = $1`, [id])).rows[0];

/** The Set-Cookie line for the session cookie, if any. */
const sessionCookie = (r: request.Response) =>
  ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("cj_session="));

describe("sessions", () => {
  it("GET /me returns the session's user", async () => {
    const u = await newUser();
    const r = await request(app).get("/me").set("Cookie", u.cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: u.userId, github_id: u.githubId, login: `test-${u.githubId}`, avatar_url: null });
    expect(sessionCookie(r)).toBeUndefined(); // fresh session: no renewal
  });

  it("GET /me is 401 without a session, and with an unknown or malformed token (cookie cleared)", async () => {
    expect((await request(app).get("/me")).status).toBe(401);
    for (const token of ["A".repeat(43), "not-a-token"]) {
      const r = await request(app).get("/me").set("Cookie", `cj_session=${token}`);
      expect(r.status).toBe(401);
      expect(sessionCookie(r)).toMatch(/^cj_session=;.*Expires=Thu, 01 Jan 1970/);
    }
  });

  it("stores only the SHA-256 of the token", async () => {
    const u = await newUser();
    const r = await d.db.pool.query(`SELECT id FROM sessions WHERE user_id = $1`, [u.userId]);
    expect(r.rows.map((x) => x.id)).toEqual([u.sessionId]);
    expect(u.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(u.sessionId).not.toContain(u.token);
  });

  it("rejects an expired session", async () => {
    const u = await newUser({ expiresInMs: -1000 });
    const r = await request(app).get("/me").set("Cookie", u.cookie);
    expect(r.status).toBe(401);
    expect(sessionCookie(r)).toMatch(/^cj_session=;/);
    const sub = await request(app).post("/submissions").set("Origin", ORIGIN).set("Cookie", u.cookie).send(body);
    expect(sub.status).toBe(401);
  });

  it("renews (sliding) at most once per day", async () => {
    const stale = await newUser({ lastSeenAgoMs: SESSION_RENEW_AFTER_MS + 60_000, expiresInMs: 3600_000 });
    const before = await sessionRow(stale.sessionId);
    const r = await request(app).get("/me").set("Cookie", stale.cookie);
    expect(r.status).toBe(200);
    const set = sessionCookie(r);
    expect(set).toContain(`cj_session=${stale.token}`);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/); // not production
    expect(set).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    const after = await sessionRow(stale.sessionId);
    expect(after.expires_at.getTime() - before.expires_at.getTime()).toBeGreaterThan(SESSION_TTL_MS - 2 * 3600_000);
    expect(after.last_seen_at.getTime()).toBeGreaterThan(before.last_seen_at.getTime());

    // Renewed just now: the next request does not touch the row.
    const again = await request(app).get("/me").set("Cookie", stale.cookie);
    expect(again.status).toBe(200);
    expect(sessionCookie(again)).toBeUndefined();
    expect((await sessionRow(stale.sessionId)).last_seen_at).toEqual(after.last_seen_at);
  });

  it("deleteExpiredSessions removes only expired rows", async () => {
    const live = await newUser();
    const dead = await newUser({ expiresInMs: -1000 });
    expect(await d.db.deleteExpiredSessions()).toBeGreaterThanOrEqual(1);
    expect(await sessionRow(dead.sessionId)).toBeUndefined();
    expect(await sessionRow(live.sessionId)).toBeDefined();
  });
});

describe("POST /submissions requires login", () => {
  it("401 anonymously; 202 with the user recorded when logged in", async () => {
    expect((await request(app).post("/submissions").set("Origin", ORIGIN).send(body)).status).toBe(401);
    const u = await newUser();
    const r = await request(app).post("/submissions").set("Origin", ORIGIN).set("Cookie", u.cookie).send(body);
    expect(r.status).toBe(202);
    const row = await d.db.pool.query(`SELECT user_id FROM submissions WHERE id = $1`, [r.body.id]);
    expect(Number(row.rows[0].user_id)).toBe(u.userId);
  });
});

describe("Origin / Referer check on non-GET routes", () => {
  it("rejects a missing, foreign, null or look-alike Origin with 403", async () => {
    const u = await newUser();
    for (const origin of [undefined, "https://evil.example", "null", "http://localhost:5174", "http://127.0.0.1:5173"]) {
      let req = request(app).post("/submissions").set("Cookie", u.cookie);
      if (origin !== undefined) req = req.set("Origin", origin);
      expect((await req.send(body)).status, String(origin)).toBe(403);
    }
    const foreignReferer = await request(app).post("/submissions").set("Cookie", u.cookie).set("Referer", "https://evil.example/x").send(body);
    expect(foreignReferer.status).toBe(403);
  });

  it("checks Origin before the body is parsed", async () => {
    const r = await request(app).post("/submissions").set("Origin", "https://evil.example").set("Content-Type", "application/json").send("{nope");
    expect(r.status).toBe(403);
  });

  it("accepts a same-origin Referer when Origin is absent", async () => {
    const u = await newUser();
    const r = await request(app).post("/submissions").set("Referer", `${ORIGIN}/problems/ledger-total`).set("Cookie", u.cookie).send(body);
    expect(r.status).toBe(202);
  });

  it("does not check GET requests", async () => {
    expect((await request(app).get("/problems").set("Origin", "https://evil.example")).status).toBe(200);
  });
});
