import { readFileSync, rmSync } from "node:fs";

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { deleteShortcutUsers, PID_FILE, STATE_FILE } from "./global-setup.ts";
import { EVIDENCE_DIR, FAILED_MARKER, REPO, stackEnv } from "./stack.ts";

export default async function globalTeardown() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pid) process.kill(pid);
  } catch {
    /* already gone */
  }
  rmSync(PID_FILE, { force: true });
  if (existsSync(FAILED_MARKER)) {
    // A test failed: keep the database rows and dump them next to the logs.
    execFileSync("npx", ["tsx", "test/e2e-evidence.ts", EVIDENCE_DIR, "shortcut"], {
      cwd: join(REPO, "api"),
      env: { ...process.env, ...stackEnv() },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    process.stdout.write(`e2e failed: evidence kept in ${EVIDENCE_DIR} (test users not deleted)
`);
  } else {
    deleteShortcutUsers();
  }
  rmSync(STATE_FILE, { force: true });
}
