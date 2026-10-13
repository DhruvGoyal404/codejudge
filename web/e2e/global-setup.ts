import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO, stackEnv } from "./stack.ts";

const runner = join(REPO, "runner");
const exe = (name: string) => join(runner, process.platform === "win32" ? `${name}.exe` : name);
export const PID_FILE = join(tmpdir(), "codejudge-playwright-worker.pid");
/** Logged-in browser state (session cookie) for every test; see playwright.config.ts. */
export const STATE_FILE = join(tmpdir(), "codejudge-playwright-state.json");
export const USER_FILE = join(tmpdir(), "codejudge-playwright-user.txt");
const api = join(REPO, "api");
const tsx = (args: string[], env: NodeJS.ProcessEnv) =>
  execFileSync("npx", ["tsx", ...args], { cwd: api, env, encoding: "utf8", shell: process.platform === "win32" });

/** Removes the test user created by globalSetup (also used by globalTeardown). */
export function deleteTestUser(userId: string) {
  tsx(["test/e2e-session.ts", "delete", userId], { ...process.env, ...stackEnv() });
}

/** Builds and starts one real judge-worker (it has no HTTP port for webServer to wait on). */
export default async function globalSetup() {
  const env = { ...process.env, ...stackEnv(), CODEJUDGE_PROBLEMS_DIR: join(REPO, "problems") };
  execFileSync("go", ["build", "-o", exe("judge-worker"), "./cmd/judge-worker"], { cwd: runner, stdio: "inherit" });
  execFileSync("go", ["build", "-o", exe("judge-admin"), "./cmd/judge-admin"], { cwd: runner, stdio: "inherit" });
  execFileSync(exe("judge-admin"), ["import", join(REPO, "problems")], { cwd: runner, env, stdio: "inherit" });
  const log = createWriteStream(join(tmpdir(), "codejudge-playwright-worker.log"));
  const worker = spawn(exe("judge-worker"), [], { cwd: runner, env: { ...env, JUDGE_WORKER_ID: `playwright-${process.pid}` }, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout!.pipe(log);
  worker.stderr!.pipe(log);
  writeFileSync(PID_FILE, String(worker.pid));

  // POST /submissions requires login: a test user with a session row, its
  // cookie handed to every browser context. (Phase 5d replaces this with the
  // test-only auth shortcut.)
  const { userId, token } = JSON.parse(tsx(["test/e2e-session.ts", "create"], env).trim().split("\n").pop()!);
  writeFileSync(USER_FILE, String(userId));
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      cookies: [{ name: "cj_session", value: token, domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [],
    }),
  );
}
