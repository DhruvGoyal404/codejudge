import { readFileSync, rmSync } from "node:fs";

import { PID_FILE } from "./global-setup.ts";

export default async function globalTeardown() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pid) process.kill(pid);
  } catch {
    /* already gone */
  }
  rmSync(PID_FILE, { force: true });
}
