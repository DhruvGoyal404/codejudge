import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, MAX_ACTIVE_PER_USER } from "../src/app.ts";
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

const submit = (u: TestUser) =>
  request(app)
    .post("/submissions")
    .set("Origin", ORIGIN)
    .set("Cookie", u.cookie)
    .send({ problemSlug: "ledger-total", language: "cpp", source: "int main(){}" });

const active = async (u: TestUser) =>
  (await d.db.pool.query(`SELECT count(*)::int AS n FROM submissions WHERE user_id = $1 AND status IN ('queued', 'running')`, [u.userId]))
    .rows[0].n as number;

const statuses = (rs: request.Response[]) => rs.map((r) => r.status).sort();

describe(`at most ${MAX_ACTIVE_PER_USER} queued|running submissions per user`, () => {
  it("the third is 409; finishing one frees a slot; running counts as active", async () => {
    const u = await newUser();
    const a = await submit(u);
    const b = await submit(u);
    expect([a.status, b.status]).toEqual([202, 202]);
    const c = await submit(u);
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/at most 2/);

    await d.db.pool.query(`UPDATE submissions SET status = 'running', started_at = now(), attempt = 1 WHERE id = $1`, [a.body.id]);
    expect((await submit(u)).status).toBe(409); // running still counts
    await d.db.pool.query(
      `UPDATE submissions SET status = 'done', verdict = 'AC', finished_at = now() WHERE id = $1`,
      [a.body.id],
    );
    expect((await submit(u)).status).toBe(202);
    expect(await active(u)).toBe(2);
    // Other users have their own cap.
    expect((await submit(await newUser())).status).toBe(202);
  });

  it("two concurrent POSTs at the cap's edge never both succeed (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const u = await newUser();
      expect((await submit(u)).status).toBe(202); // one active: room for exactly one more
      const rs = await Promise.all([submit(u), submit(u)]);
      expect(statuses(rs), `round ${round}`).toEqual([202, 409]);
      expect(await active(u)).toBe(2);
    }
  });

  it("a burst of 6 concurrent POSTs admits exactly 2 (10 rounds)", async () => {
    for (let round = 0; round < 10; round++) {
      const u = await newUser();
      const rs = await Promise.all(Array.from({ length: 6 }, () => submit(u)));
      expect(statuses(rs), `round ${round}`).toEqual([202, 202, 409, 409, 409, 409]);
      expect(await active(u)).toBe(2);
    }
  });

  it("at the cap, concurrent POSTs are all refused", async () => {
    const u = await newUser();
    await submit(u);
    await submit(u);
    const rs = await Promise.all([submit(u), submit(u), submit(u)]);
    expect(statuses(rs)).toEqual([409, 409, 409]);
    expect(await active(u)).toBe(2);
  });
});
