// Starts the API for Playwright's webServer and copies its output to
// $E2E_EVIDENCE_DIR/api.log (failure evidence), while still printing it.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.E2E_EVIDENCE_DIR ?? join(tmpdir(), "codejudge-e2e-evidence");
mkdirSync(dir, { recursive: true });
const log = createWriteStream(join(dir, "api.log")); // truncated per run
const api = fileURLToPath(new URL("../../api/", import.meta.url));
const child = spawn("npx", ["tsx", "src/server.ts"], { cwd: api, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
for (const s of [child.stdout, child.stderr]) {
  s.on("data", (b) => {
    log.write(b);
    process.stdout.write(b);
  });
}
const stop = () => child.kill();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
