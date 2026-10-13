import { readFileSync, rmSync } from "node:fs";

import { deleteTestUser, PID_FILE, STATE_FILE, USER_FILE } from "./global-setup.ts";

export default async function globalTeardown() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pid) process.kill(pid);
  } catch {
    /* already gone */
  }
  rmSync(PID_FILE, { force: true });
  try {
    deleteTestUser(readFileSync(USER_FILE, "utf8").trim());
  } catch {
    /* setup never created one */
  }
  rmSync(USER_FILE, { force: true });
  rmSync(STATE_FILE, { force: true });
}
