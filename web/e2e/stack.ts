import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** A seed problem's solution file: from the private problems repo when $CODEJUDGE_PROBLEMS_TESTS_DIR is set. */
export function solutionPath(slug: string, file: string): string {
  const root = process.env.CODEJUDGE_PROBLEMS_TESTS_DIR ?? `${REPO}problems`;
  return `${root}/${slug}/solutions/${file}`;
}

/**
 * Failure evidence (worker and API logs; on a failed test, the affected
 * submission and run records instead of cleanup). CI uploads it as an artifact.
 */
export const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? join(tmpdir(), "codejudge-e2e-evidence");
/** Written by the failure reporter when any test fails; read by global teardown. */
export const FAILED_MARKER = join(EVIDENCE_DIR, "failed-tests.txt");

/** CODEJUDGE_* URLs: from the environment (CI), else derived from the repo's .env (dev compose stack). */
export function stackEnv(): Record<string, string> {
  if (process.env.CODEJUDGE_DATABASE_URL && process.env.CODEJUDGE_VALKEY_URL) {
    return { CODEJUDGE_DATABASE_URL: process.env.CODEJUDGE_DATABASE_URL, CODEJUDGE_VALKEY_URL: process.env.CODEJUDGE_VALKEY_URL };
  }
  const kv = Object.fromEntries(
    readFileSync(`${REPO}.env`, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return {
    CODEJUDGE_DATABASE_URL:
      process.env.CODEJUDGE_DATABASE_URL ??
      `postgres://codejudge:${kv.CODEJUDGE_PG_PASSWORD}@127.0.0.1:${kv.CODEJUDGE_PG_PORT ?? 55432}/codejudge?sslmode=disable`,
    CODEJUDGE_VALKEY_URL: process.env.CODEJUDGE_VALKEY_URL ?? `redis://127.0.0.1:${kv.CODEJUDGE_VALKEY_PORT ?? 56379}`,
  };
}
