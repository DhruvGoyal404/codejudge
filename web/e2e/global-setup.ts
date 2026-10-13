import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO, stackEnv } from "./stack.ts";

const runner = join(REPO, "runner");
const exe = (name: string) => join(runner, process.platform === "win32" ? `${name}.exe` : name);
export const PID_FILE = join(tmpdir(), "codejudge-playwright-worker.pid");

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
}
