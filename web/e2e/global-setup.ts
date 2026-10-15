import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVIDENCE_DIR, FAILED_MARKER, REPO, stackEnv } from "./stack.ts";

const runner = join(REPO, "runner");
const exe = (name: string) => join(runner, process.platform === "win32" ? `${name}.exe` : name);
export const PID_FILE = join(tmpdir(), "codejudge-playwright-worker.pid");
/** Logged-in browser state written by the "setup" project (auth.setup.ts). */
export const STATE_FILE = join(tmpdir(), "codejudge-playwright-state.json");

/** Deletes every user created through the test-only auth shortcut (negative github_id). */
export function deleteShortcutUsers() {
  execFileSync("npx", ["tsx", "test/e2e-cleanup.ts"], {
    cwd: join(REPO, "api"),
    env: { ...process.env, ...stackEnv() },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/** Builds and starts one real judge-worker (it has no HTTP port for webServer to wait on). */
export default async function globalSetup() {
  const env = { ...process.env, ...stackEnv(), CODEJUDGE_PROBLEMS_DIR: join(REPO, "problems") };
  execFileSync("go", ["build", "-o", exe("judge-worker"), "./cmd/judge-worker"], { cwd: runner, stdio: "inherit" });
  execFileSync("go", ["build", "-o", exe("judge-admin"), "./cmd/judge-admin"], { cwd: runner, stdio: "inherit" });
  execFileSync(exe("judge-admin"), ["import", join(REPO, "problems")], { cwd: runner, env, stdio: "inherit" });
  // The API (webServer) may already be writing api.log here: remove only
  // what a previous run left behind.
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const f of [FAILED_MARKER, join(EVIDENCE_DIR, "records.json")]) rmSync(f, { force: true });
  const log = createWriteStream(join(EVIDENCE_DIR, "worker.log"));
  const worker = spawn(exe("judge-worker"), [], { cwd: runner, env: { ...env, JUDGE_WORKER_ID: `playwright-${process.pid}` }, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout!.pipe(log);
  worker.stderr!.pipe(log);
  writeFileSync(PID_FILE, String(worker.pid));
}
