import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { OAUTH_STATE_TTL_S } from "../src/auth.ts";
import { sha256hex } from "../src/sessions.ts";
import { deleteTestUsers, ORIGIN, testDeps, type TestDeps } from "./helpers.ts";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "http://localhost:5173/api/auth/github/callback";

// ---- mock GitHub ---------------------------------------------------------

interface GhUser {
  id: number;
  login: string;
  avatar_url: string | null;
}
/** code -> what GitHub knows about it (the PKCE challenge it was issued for, the user). */
const codes = new Map<string, { challenge: string; user: GhUser }>();
const tokens = new Map<string, GhUser>();
let tokenCalls: Record<string, unknown>[] = [];
let tokenHeaders: IncomingMessage["headers"][] = [];
let userHeaders: IncomingMessage["headers"][] = [];
let userStatus = 200;
let gh: Server;
let ghBase: string;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

function startMockGitHub(): Promise<void> {
  gh = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/login/oauth/access_token") {
      const body = JSON.parse(await readBody(req)) as Record<string, string>;
      tokenCalls.push(body);
      tokenHeaders.push(req.headers);
      const issued = codes.get(body.code!);
      codes.delete(body.code!); // codes are single-use at GitHub too
      const verifierOk =
        issued && createHash("sha256").update(body.code_verifier ?? "").digest("base64url") === issued.challenge;
      if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return json(200, { error: "incorrect_client_credentials" });
      if (!issued || body.redirect_uri !== REDIRECT_URI) return json(200, { error: "bad_verification_code" });
      if (!verifierOk) return json(200, { error: "bad_verification_code" }); // PKCE mismatch
      const token = `gho_test_${Math.random().toString(36).slice(2)}`;
      tokens.set(token, issued.user);
      return json(200, { access_token: token, token_type: "bearer", scope: "read:user" });
    }
    if (req.method === "GET" && req.url === "/user") {
      userHeaders.push(req.headers);
      if (userStatus !== 200) return json(userStatus, { message: "boom" });
      const user = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      return user ? json(200, { ...user, name: "ignored", email: null }) : json(401, { message: "Bad credentials" });
    }
    json(404, { message: "Not Found" });
  });
  return new Promise((resolve) =>
    gh.listen(0, "127.0.0.1", () => {
      ghBase = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// ---- app under test ------------------------------------------------------

let d: TestDeps;
let app: ReturnType<typeof createApp>;
const githubIds: number[] = [];

beforeAll(async () => {
  await startMockGitHub();
  d = testDeps({
    GITHUB_CLIENT_ID: CLIENT_ID,
    GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_REDIRECT_URI: REDIRECT_URI,
    GITHUB_OAUTH_URL: ghBase,
    GITHUB_API_URL: ghBase,
  });
  app = createApp(d);
  // The queue client has no offline queue: wait until Valkey is connected.
  if (d.queue.redis.status !== "ready") await new Promise((r) => d.queue.redis.once("ready", r));
});

afterAll(async () => {
  const r = await d.db.pool.query(`SELECT id FROM users WHERE github_id = ANY($1::bigint[])`, [githubIds]);
  await deleteTestUsers(d.db, r.rows.map((x) => Number(x.id)));
  await d.close();
  await new Promise((r) => gh.close(r));
});

beforeEach(() => {
  tokenCalls = [];
  tokenHeaders = [];
  userHeaders = [];
  userStatus = 200;
});

function ghUser(login = "octo"): GhUser {
  const id = 8_000_000_000_000 + Math.floor(Math.random() * 1e12);
  githubIds.push(id);
  return { id, login: `${login}-${id}`, avatar_url: `https://avatars.example/u/${id}` };
}

const setCookies = (r: request.Response) => ([] as string[]).concat(r.headers["set-cookie"] ?? []);
const cookieLine = (r: request.Response, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`));
const cookieValue = (line: string | undefined) => line?.slice(line.indexOf("=") + 1, line.indexOf(";"));

/** GET /auth/github: returns what the browser would carry to GitHub and back. */
async function startLogin(a = app) {
  const r = await request(a).get("/auth/github");
  expect(r.status).toBe(302);
  const url = new URL(r.headers.location!);
  const oauthLine = cookieLine(r, "cj_oauth") ?? cookieLine(r, "__Host-cj_oauth");
  return { r, url, state: url.searchParams.get("state")!, challenge: url.searchParams.get("code_challenge")!, oauthLine, oauthCookie: `cj_oauth=${cookieValue(oauthLine)}` };
}

/** Simulates GitHub approving the login: a code bound to this attempt's challenge. */
function approve(challenge: string, user: GhUser) {
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { challenge, user });
  return code;
}

const callback = (query: string, cookie?: string) => {
  const req = request(app).get(`/auth/github/callback?${query}`);
  return cookie ? req.set("Cookie", cookie) : req;
};

/** Full login; returns the session cookie header value. */
async function login(user: GhUser) {
  const { state, challenge, oauthCookie } = await startLogin();
  const r = await callback(`code=${approve(challenge, user)}&state=${state}`, oauthCookie);
  expect(r.headers.location).toBe(`${ORIGIN}/`);
  return `cj_session=${cookieValue(cookieLine(r, "cj_session"))}`;
}

const expectLoginError = (r: request.Response, code: string) => {
  expect(r.status).toBe(302);
  expect(r.headers.location).toBe(`${ORIGIN}/?login_error=${code}`);
  expect(cookieLine(r, "cj_session")).toBeUndefined();
};

// ---- tests ---------------------------------------------------------------

describe("GitHub OAuth: happy path", () => {
  it("redirects to GitHub with state, PKCE S256 and read:user", async () => {
    const { r, url, state, challenge, oauthLine } = await startLogin();
    expect(url.origin + url.pathname).toBe(`${ghBase}/login/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(oauthLine).toContain(`cj_oauth=${state}`);
    expect(oauthLine).toMatch(/HttpOnly/);
    expect(oauthLine).toMatch(/SameSite=Lax/);
    expect(oauthLine).toMatch(/Path=\//);
    expect(oauthLine).toContain(`Max-Age=${OAUTH_STATE_TTL_S}`);
    expect(r.headers["cache-control"]).toBe("no-store");
    // Two logins never share a state.
    expect((await startLogin()).state).not.toBe(state);
  });

  it("exchanges the code with the PKCE verifier, creates the user and a hashed session", async () => {
    const user = ghUser();
    const { state, challenge, oauthCookie } = await startLogin();
    const r = await callback(`code=${approve(challenge, user)}&state=${state}`, oauthCookie);

    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`${ORIGIN}/`);
    // Token request: JSON accepted, verifier present (the mock checked it against the challenge).
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toMatchObject({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI });
    expect(tokenCalls[0]!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHeaders[0]!.accept).toBe("application/json");
    expect(userHeaders[0]!.authorization).toMatch(/^Bearer gho_test_/);
    expect(userHeaders[0]!["user-agent"]).toBe("CodeJudge");

    // The state cookie is cleared; the session cookie is set.
    expect(cookieLine(r, "cj_oauth")).toMatch(/^cj_oauth=;/);
    const line = cookieLine(r, "cj_session")!;
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Lax/);
    expect(line).toMatch(/Path=\//);
    expect(line).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(line).not.toMatch(/Secure/);
    const token = cookieValue(line)!;

    const row = await d.db.pool.query(
      `SELECT s.id, u.login, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.github_id = $1`,
      [user.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].id).toBe(sha256hex(token)); // only the hash is stored
    expect(row.rows[0]).toMatchObject({ login: user.login, avatar_url: user.avatar_url });

    const me = await request(app).get("/me").set("Cookie", `cj_session=${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ github_id: user.id, login: user.login, avatar_url: user.avatar_url });
  });

  it("upserts by github_id: a second login updates login/avatar and keeps the user id", async () => {
    const user = ghUser("before");
    const first = await request(app).get("/me").set("Cookie", await login(user));
    const renamed = { ...user, login: `after-${user.id}`, avatar_url: null };
    const second = await request(app).get("/me").set("Cookie", await login(renamed));
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({ login: renamed.login, avatar_url: null });
  });

  it("logging in while logged in replaces the old session", async () => {
    const user = ghUser();
    const old = await login(user);
    const { state, challenge, oauthCookie } = await startLogin();
    const r = await callback(`code=${approve(challenge, user)}&state=${state}`, `${oauthCookie}; ${old}`);
    expect(r.headers.location).toBe(`${ORIGIN}/`);
    expect((await request(app).get("/me").set("Cookie", old)).status).toBe(401);
    const fresh = `cj_session=${cookieValue(cookieLine(r, "cj_session"))}`;
    expect((await request(app).get("/me").set("Cookie", fresh)).status).toBe(200);
  });
});

describe("GitHub OAuth: bad state", () => {
  it("rejects a mismatched, missing, or duplicated state without calling GitHub", async () => {
    const user = ghUser();
    const a = await startLogin();
    const b = await startLogin();
    const code = approve(a.challenge, user);
    const cases: [string, string | undefined][] = [
      [`code=${code}&state=${b.state}`, a.oauthCookie], // someone else's state
      [`code=${code}&state=${a.state}`, undefined], // no state cookie (login CSRF)
      [`code=${code}&state=${a.state}`, `cj_oauth=${a.state}x`], // tampered cookie
      [`code=${code}`, a.oauthCookie], // no state parameter
      [`code=${code}&state=${a.state}&state=${a.state}`, a.oauthCookie], // array
      [`code=${code}&state=${"x".repeat(500)}`, a.oauthCookie], // oversized
    ];
    for (const [query, cookie] of cases) expectLoginError(await callback(query, cookie), "state");
    expect(tokenCalls).toHaveLength(0);
  });

  it("rejects a state whose server-side record expired, even with a matching cookie", async () => {
    const { state, challenge, oauthCookie } = await startLogin();
    await d.queue.redis.del(`auth:state:${sha256hex(state)}`); // what the 10-minute TTL does
    expectLoginError(await callback(`code=${approve(challenge, ghUser())}&state=${state}`, oauthCookie), "state");
    expect(tokenCalls).toHaveLength(0);
  });
});

describe("GitHub OAuth: replayed state", () => {
  it("a state (with its cookie) works once; the replayed callback is refused", async () => {
    const user = ghUser();
    const { state, challenge, oauthCookie } = await startLogin();
    const query = `code=${approve(challenge, user)}&state=${state}`;
    const ok = await callback(query, oauthCookie);
    expect(ok.headers.location).toBe(`${ORIGIN}/`);
    // Same URL, same cookie (e.g. captured or the cookie was not cleared): refused.
    expectLoginError(await callback(query, oauthCookie), "state");
    // A fresh code with the old state is refused too.
    expectLoginError(await callback(`code=${approve(challenge, user)}&state=${state}`, oauthCookie), "state");
    expect(tokenCalls).toHaveLength(1);
  });

  it("a cancelled login consumes its state", async () => {
    const { state, challenge, oauthCookie } = await startLogin();
    expectLoginError(await callback(`error=access_denied&state=${state}`, oauthCookie), "denied");
    expectLoginError(await callback(`code=${approve(challenge, ghUser())}&state=${state}`, oauthCookie), "state");
    expect(tokenCalls).toHaveLength(0);
  });
});

describe("GitHub OAuth: GitHub failures", () => {
  it("200 with an error (no access_token) is a failure; no user or session is created", async () => {
    const user = ghUser();
    const { state, oauthCookie } = await startLogin();
    // A code issued for a different challenge: the PKCE verifier won't match.
    const code = approve("A".repeat(43), user);
    expectLoginError(await callback(`code=${code}&state=${state}`, oauthCookie), "github");
    expect(tokenCalls).toHaveLength(1);
    expect(userHeaders).toHaveLength(0);
    expect((await d.db.pool.query(`SELECT 1 FROM users WHERE github_id = $1`, [user.id])).rowCount).toBe(0);
  });

  it("a failing /user call is a failure", async () => {
    const user = ghUser();
    userStatus = 500;
    const { state, challenge, oauthCookie } = await startLogin();
    expectLoginError(await callback(`code=${approve(challenge, user)}&state=${state}`, oauthCookie), "github");
    expect((await d.db.pool.query(`SELECT 1 FROM users WHERE github_id = $1`, [user.id])).rowCount).toBe(0);
  });
});

describe("sessions after login", () => {
  it("an expired session is rejected", async () => {
    const user = ghUser();
    const cookie = await login(user);
    await d.db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [sha256hex(cookie.slice("cj_session=".length))]);
    const r = await request(app).get("/me").set("Cookie", cookie);
    expect(r.status).toBe(401);
    expect(cookieLine(r, "cj_session")).toMatch(/^cj_session=;/);
  });

  it("logout deletes the session row and invalidates the cookie immediately", async () => {
    const cookie = await login(ghUser());
    const id = sha256hex(cookie.slice("cj_session=".length));
    expect((await request(app).get("/me").set("Cookie", cookie)).status).toBe(200);

    // Cross-origin logout is refused (Origin check) and changes nothing.
    expect((await request(app).post("/auth/logout").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get("/me").set("Cookie", cookie)).status).toBe(200);

    const out = await request(app).post("/auth/logout").set("Origin", ORIGIN).set("Cookie", cookie);
    expect(out.status).toBe(204);
    expect(cookieLine(out, "cj_session")).toMatch(/^cj_session=;/);
    expect((await d.db.pool.query(`SELECT 1 FROM sessions WHERE id = $1`, [id])).rowCount).toBe(0);
    expect((await request(app).get("/me").set("Cookie", cookie)).status).toBe(401);
    // Logging out again (or anonymously) is harmless.
    expect((await request(app).post("/auth/logout").set("Origin", ORIGIN).set("Cookie", cookie)).status).toBe(204);
  });
});

describe("configuration", () => {
  it("503 when the GitHub app is not configured", async () => {
    const bare = createApp({ ...d, config: { ...d.config, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined } });
    expect((await request(bare).get("/auth/github")).status).toBe(503);
  });

  it("production uses Secure __Host- cookies", async () => {
    const prod = createApp({ ...d, config: { ...d.config, NODE_ENV: "production" } });
    const { oauthLine } = await startLogin(prod);
    expect(oauthLine).toMatch(/^__Host-cj_oauth=/);
    expect(oauthLine).toMatch(/Secure/);
    expect(oauthLine).toMatch(/HttpOnly/);
    expect(oauthLine).not.toMatch(/Domain=/);
  });
});
