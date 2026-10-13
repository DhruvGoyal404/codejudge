import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { testAuthRouter } from "../src/testAuth.ts";
import { devEnv, ORIGIN, testDeps, type TestDeps } from "./helpers.ts";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Runs the real server entry point (node --import tsx src/server.ts) with
 * extra env. Resolves with the exit code and output, or with code null once
 * it logs "api listening" (then it is killed).
 */
function runServer(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: API_DIR,
      env: { ...devEnv(), LOG_LEVEL: "info", PORT: String(20000 + Math.floor(Math.random() * 20000)), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server neither exited nor listened within 60 s:\n${out}`));
    }, 60_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.includes('"api listening"')) {
        clearTimeout(timer);
        child.kill();
        resolve({ code: null, out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe("test auth shortcut: refuses to start outside NODE_ENV=test", () => {
  it("config validation rejects it for development and production, accepts it for test", () => {
    const { NODE_ENV: _vitestSetsThis, ...env } = devEnv();
    const base = { ...env, TEST_AUTH_SHORTCUT: "1" };
    expect(() => loadConfig({ ...base, NODE_ENV: "development" })).toThrow(/only allowed with NODE_ENV=test/);
    expect(() => loadConfig({ ...base })).toThrow(/only allowed with NODE_ENV=test/); // NODE_ENV unset = development
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", PUBLIC_ORIGIN: "https://judge.example", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y" }),
    ).toThrow(/only allowed with NODE_ENV=test/);
    expect(loadConfig({ ...base, NODE_ENV: "test" }).TEST_AUTH_SHORTCUT).toBe(true);
    expect(loadConfig({ ...devEnv(), NODE_ENV: "test" }).TEST_AUTH_SHORTCUT).toBe(false);
    expect(() => loadConfig({ ...devEnv(), TEST_AUTH_SHORTCUT: "yes" })).toThrow();
  });

  it("the router itself refuses a hand-built config outside test", () => {
    const d = { db: {} as never, sessions: {} as never };
    const cfg = loadConfig({ ...devEnv(), NODE_ENV: "test" });
    expect(() => testAuthRouter({ ...d, config: { ...cfg, TEST_AUTH_SHORTCUT: true, NODE_ENV: "development" } })).toThrow();
    expect(() => testAuthRouter({ ...d, config: { ...cfg, TEST_AUTH_SHORTCUT: true, NODE_ENV: "production" } })).toThrow();
    expect(() => testAuthRouter({ ...d, config: { ...cfg, TEST_AUTH_SHORTCUT: false } })).toThrow();
  });

  it.each([
    ["development", {}],
    ["production", { PUBLIC_ORIGIN: "https://judge.example", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y" }],
  ])("the real server process exits non-zero with NODE_ENV=%s", async (nodeEnv, extra) => {
    const r = await runServer({ NODE_ENV: nodeEnv, TEST_AUTH_SHORTCUT: "1", ...extra });
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull(); // never reached "api listening"
    expect(r.out).toMatch(/only allowed with NODE_ENV=test/);
  }, 90_000);

  it("control: with NODE_ENV=test the same server starts", async () => {
    const r = await runServer({ NODE_ENV: "test", TEST_AUTH_SHORTCUT: "1" });
    expect(r.code).toBeNull();
    expect(r.out).toContain("TEST AUTH SHORTCUT ENABLED");
  }, 90_000);
});

describe("POST /test/login", () => {
  let off: TestDeps;
  let on: TestDeps;
  beforeAll(() => {
    off = testDeps({ NODE_ENV: "test" });
    on = testDeps({ NODE_ENV: "test", TEST_AUTH_SHORTCUT: "1" });
  });
  afterAll(async () => {
    await on.db.pool.query(`DELETE FROM users WHERE github_id < 0 AND login = 'e2e-unit-test'`);
    await Promise.all([off.close(), on.close()]);
  });

  it("does not exist unless enabled", async () => {
    const r = await request(createApp(off)).post("/test/login").set("Origin", ORIGIN).send({ login: "unit-test" });
    expect(r.status).toBe(404);
  });

  it("when enabled: creates a throwaway user and a normal session (Origin check still applies)", async () => {
    const app = createApp(on);
    expect((await request(app).post("/test/login").send({ login: "unit-test" })).status).toBe(403);
    const r = await request(app).post("/test/login").set("Origin", ORIGIN).send({ login: "unit-test" });
    expect(r.status).toBe(200);
    expect(r.body.github_id).toBeLessThan(0);
    const cookie = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("cj_session="))!;
    expect(cookie).toMatch(/HttpOnly/);
    const me = await request(app).get("/me").set("Cookie", cookie.split(";")[0]!);
    expect(me.body).toMatchObject({ login: "e2e-unit-test", github_id: r.body.github_id });
    expect((await request(app).post("/test/login").set("Origin", ORIGIN).send({ login: "Bad Name" })).status).toBe(400);
  });
});
