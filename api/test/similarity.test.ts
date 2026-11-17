import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEMPLATES as WEB_TEMPLATES } from "../../web/src/lib/templates.ts";
import { createApp } from "../src/app.ts";
import { compare, fingerprints } from "../src/similarity/fingerprint.ts";
import { tokenize } from "../src/similarity/lexer.ts";
import { THRESHOLD } from "../src/similarity/routes.ts";
import { TEMPLATES } from "../src/similarity/templates.ts";
import { createTestUser, deleteTestUsers, testDeps, type TestDeps, type TestUser } from "./helpers.ts";

const cpp = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;               // read the count
    vector<long long> a(n);
    for (auto &x : a) cin >> x;
    long long best = 0, cur = 0;
    for (int i = 0; i < n; i++) {
        cur = max(a[i], cur + a[i]);
        best = max(best, cur);
    }
    cout << best << "\\n";
}
`;
const disguised = `#include <iostream>
#include <vector>
using namespace std;
/* totally original */
int main(){int count;cin>>count;vector<long long> values(count);
for(auto &v:values)cin>>v; long long top=0,run=0;
for(int k=0;k<count;k++){run=max(values[k],run+values[k]);top=max(top,run);} cout<<top<<"\\n";}
`;
const different = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n), pre(n + 1, 0);
    for (int i = 0; i < n; i++) { cin >> a[i]; pre[i + 1] = pre[i] + a[i]; }
    long long best = LLONG_MIN, lo = 0;
    for (int i = 1; i <= n; i++) { best = max(best, pre[i] - lo); lo = min(lo, pre[i]); }
    printf("%lld\\n", best);
}
`;

describe("tokenizer and fingerprints", () => {
  it("ignore renaming, comments, literals and formatting", () => {
    const sim = compare(fingerprints("cpp", cpp), fingerprints("cpp", disguised)).similarity;
    expect(sim).toBeGreaterThanOrEqual(0.95);
    expect(compare(fingerprints("cpp", cpp), fingerprints("cpp", different)).similarity).toBeLessThan(THRESHOLD);
  });

  it("keep Python's block structure", () => {
    const a = "for i in range(n):\n    s += i\nprint(s)\n";
    const b = "for i in range(n):\n    s += i\n    print(s)\n";
    expect(tokenize("python", a).map((t) => t.k)).not.toEqual(tokenize("python", b).map((t) => t.k));
    expect(tokenize("python", a).map((t) => t.k)).toEqual(tokenize("python", "# c\nfor j in range(m):  # x\n    t += j\n\nprint(t)\n").map((t) => t.k));
  });

  it("drop strings' contents and boilerplate lines", () => {
    expect(tokenize("java", 'import java.util.*;\nclass Main { String s = "a // b"; }').map((t) => t.k)).toEqual(["class", "V", "{", "String", "V", "=", "S", ";", "}"]);
  });

  it("use the same starter code as the editor", () => {
    expect(TEMPLATES).toEqual(WEB_TEMPLATES);
  });
});

let d: TestDeps;
let app: ReturnType<typeof createApp>;
let admin: TestUser, alice: TestUser, bob: TestUser, carol: TestUser;
const SLUG = "pair-sums";

async function submit(u: TestUser, source: string) {
  const r = await d.db.pool.query(
    `INSERT INTO submissions (problem_id, language, source, status, verdict, user_id, finished_at)
     SELECT id, 'cpp', $2, 'done', 'AC', $1, now() FROM problems WHERE slug = $3 RETURNING id`,
    [u.userId, source, SLUG],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  d = testDeps();
  app = createApp(d);
  admin = await createTestUser(d.db);
  alice = await createTestUser(d.db);
  bob = await createTestUser(d.db);
  carol = await createTestUser(d.db);
  await d.db.pool.query(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.userId]);
});
afterAll(async () => {
  await deleteTestUsers(d.db, [admin, alice, bob, carol].map((u) => u.userId));
  await d.close();
});

describe("admin similarity page", () => {
  it("is invisible to everyone but admins", async () => {
    expect((await request(app).get(`/admin/similarity?problem=${SLUG}`)).status).toBe(401);
    expect((await request(app).get(`/admin/similarity?problem=${SLUG}`).set("Cookie", alice.cookie)).status).toBe(404);
    expect((await request(app).get(`/admin/similarity/pair?a=x&b=y`).set("Cookie", alice.cookie)).status).toBe(404);
  });

  it("ranks a disguised copy, not independent code or one user's resubmissions", async () => {
    const a = await submit(alice, cpp);
    const b = await submit(bob, disguised);
    const c = await submit(carol, different);
    await submit(alice, cpp + "\n// again\n"); // the same user resubmitting is not copying
    const r = await request(app).get(`/admin/similarity?problem=${SLUG}`).set("Cookie", admin.cookie);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toContain("no-store");
    const ids = r.body.pairs.map((p: { a: string; b: string }) => [p.a, p.b].sort().join());
    expect(ids).toContain([a, b].sort().join());
    expect(ids.some((x: string) => x.includes(c))).toBe(false);
    for (const p of r.body.pairs) expect(p.similarity).toBeGreaterThanOrEqual(THRESHOLD);

    const pair = await request(app).get(`/admin/similarity/pair?a=${a}&b=${b}`).set("Cookie", admin.cookie);
    expect(pair.status).toBe(200);
    expect(pair.body.similarity).toBeGreaterThanOrEqual(THRESHOLD);
    expect(pair.body.a.regions.length).toBeGreaterThan(0);
    expect([pair.body.a.id, pair.body.b.id]).toEqual([a, b]);
    expect(pair.body.a.login).toBeTruthy();
  });
});
