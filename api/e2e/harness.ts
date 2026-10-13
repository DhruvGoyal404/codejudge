import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, sweepOnce } from "../src/app.ts";
import { EventConsumer } from "../src/events.ts";
import { testDeps, type TestDeps } from "../test/helpers.ts";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const RUNNER = join(REPO, "runner");
export const PROBLEMS = join(REPO, "problems");
const WORKER_BIN = join(RUNNER, process.platform === "win32" ? "judge-worker.exe" : "judge-worker");
const ADMIN_BIN = join(RUNNER, process.platform === "win32" ? "judge-admin.exe" : "judge-admin");

/** Builds the Go binaries and re-imports problems so content hashes are current. */
export function prepare(env: NodeJS.ProcessEnv): void {
  execFileSync("go", ["build", "-o", WORKER_BIN, "./cmd/judge-worker"], { cwd: RUNNER, stdio: "inherit" });
  execFileSync("go", ["build", "-o", ADMIN_BIN, "./cmd/judge-admin"], { cwd: RUNNER, stdio: "inherit" });
  execFileSync(ADMIN_BIN, ["import", PROBLEMS], { cwd: RUNNER, env, stdio: "inherit" });
}

export interface Stack {
  d: TestDeps;
  base: string;
  run: string;
  created: string[];
  workers: Map<string, ChildProcess>;
  startWorker(id: string, extra?: Record<string, string>): ChildProcess;
  killWorker(id: string): void; // hard kill (TerminateProcess / SIGKILL)
  submit(slug: string, file: string): Promise<string>;
  sse(id: string, timeoutMs?: number): Promise<{ event: string; data: any }[]>;
  close(): Promise<void>;
}

/** API in-process (real Express app + event consumer + fast sweeper) and worker processes. */
export async function startStack(opts: { sweepAfterMs?: number } = {}): Promise<Stack> {
  const run = randomBytes(4).toString("hex");
  const d = testDeps({ SWEEP_AFTER_MS: String(opts.sweepAfterMs ?? 60_000), SSE_POLL_MS: "2000" });
  const consumer = new EventConsumer(d.config.CODEJUDGE_VALKEY_URL, d.config.EVENTS_STREAM, d.hub, d.log, 1000);
  consumer.start();
  const app = createApp(d);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sweeper = setInterval(() => void sweepOnce(d).catch(() => {}), 500);
  const created: string[] = [];
  const workers = new Map<string, ChildProcess>();

  const workerEnv = (id: string, extra: Record<string, string>) => ({
    ...process.env,
    CODEJUDGE_DATABASE_URL: d.config.CODEJUDGE_DATABASE_URL,
    CODEJUDGE_VALKEY_URL: d.config.CODEJUDGE_VALKEY_URL,
    CODEJUDGE_PROBLEMS_DIR: PROBLEMS,
    JUDGE_SUBMISSIONS_STREAM: d.config.SUBMISSIONS_STREAM,
    JUDGE_EVENTS_STREAM: d.config.EVENTS_STREAM,
    JUDGE_WORKER_ID: id,
    ...extra,
  });

  const killWorker = (id: string) => {
    workers.get(id)?.kill("SIGKILL");
    workers.delete(id);
  };

  return {
    d,
    base,
    run,
    created,
    workers,
    startWorker(id, extra = {}) {
      const log = createWriteStream(join(tmpdir(), `codejudge-e2e-${run}-${id}.log`));
      const child = spawn(WORKER_BIN, [], { cwd: RUNNER, env: workerEnv(id, extra), stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.pipe(log);
      child.stderr!.pipe(log);
      workers.set(id, child);
      return child;
    },
    killWorker,
    async submit(slug, file) {
      const source = readFileSync(join(PROBLEMS, slug, "solutions", file), "utf8");
      const language = file.endsWith(".py") ? "python" : "cpp";
      const r = await fetch(`${base}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemSlug: slug, language, source }),
      });
      if (r.status !== 202) throw new Error(`POST /submissions -> ${r.status} ${await r.text()}`);
      const { id } = (await r.json()) as { id: string };
      created.push(id);
      return id;
    },
    async sse(id, timeoutMs = 300_000) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}/submissions/${id}/events`, { signal: ac.signal });
        const text = await res.text(); // the server closes the stream after the verdict
        return text
          .split("\n\n")
          .filter((b) => b.startsWith("event:"))
          .map((b) => {
            const [ev, data] = b.split("\n");
            return { event: ev!.slice(7), data: JSON.parse(data!.slice(6)) };
          });
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      clearInterval(sweeper);
      for (const id of [...workers.keys()]) killWorker(id);
      server.closeAllConnections();
      server.close();
      await consumer.stop();
      if (created.length) await d.db.pool.query(`DELETE FROM submissions WHERE id = ANY($1::uuid[])`, [created]);
      await d.close();
    },
  };
}

/** Polls until fn returns a truthy value or the timeout passes. */
export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs: number, everyMs = 200): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Sandbox containers (any state) carrying judge.instance = id. */
export function containersOf(instance: string): string[] {
  const out = execFileSync("docker", ["ps", "-aq", "--filter", `label=judge.instance=${instance}`], { encoding: "utf8" });
  return out.split(/\s+/).filter(Boolean);
}
