import { Router, type Request } from "express";
import { z } from "zod";

import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { requireUser } from "../sessions.ts";
import { compare, fingerprints } from "./fingerprint.ts";
import type { Lang } from "./lexer.ts";
import { TEMPLATES } from "./templates.ts";

/** Bump when the tokenizer or fingerprinting changes: stored fingerprints are recomputed. */
export const FP_VERSION = 1;
/** Chosen from the eval (api/scripts/similarity-eval.ts): max F0.5, 99.9% precision, 99.0% recall. */
export const THRESHOLD = 0.66;
const MAX_PER_REQUEST = 2000; // fingerprints computed per page load (the rest on the next one)

/** Starter-code fingerprints: shared by every program that starts from the editor's template. */
const BASE = [...new Set(Object.entries(TEMPLATES).flatMap(([lang, src]) => fingerprints(lang as Lang, src).map((f) => f.hash)))];

/** Idioms most users share on a problem are not evidence of copying. */
const commonMin = (users: number) => Math.max(3, Math.ceil(users / 4));

/**
 * Similarity (docs/INSIGHTS.md, M2): admin-only, for a human to review.
 * Results are leads, not verdicts: the page says so, nothing is shown to
 * other users, and nothing happens automatically. Non-admins get 404, the
 * same as a route that doesn't exist.
 */
export function similarityRouter({ db }: { db: Db }) {
  const r = Router();

  async function requireAdmin(req: Request) {
    const user = requireUser(req);
    if (!(await db.isAdmin(user.id))) throw new HttpError(404, "not found");
    return user;
  }

  async function fingerprintProblem(problemId: string) {
    for (const s of await db.unfingerprinted(problemId, FP_VERSION, MAX_PER_REQUEST)) {
      await db.storeFingerprints(s.id, problemId, FP_VERSION, fingerprints(s.language as Lang, s.source));
    }
  }

  r.get("/admin/similarity", async (req, res) => {
    await requireAdmin(req);
    const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).safeParse(req.query.problem);
    if (!slug.success) throw new HttpError(400, "problem is required");
    const problemId = await db.problemIdBySlug(slug.data);
    if (problemId === null) throw new HttpError(404, "problem not found");
    await fingerprintProblem(String(problemId));
    const users = await db.distinctSubmitters(String(problemId));
    const pairs = await db.similarPairs(String(problemId), BASE, commonMin(users), THRESHOLD, 100);
    res.set("Cache-Control", "private, no-store");
    res.json({ problem: slug.data, threshold: THRESHOLD, submitters: users, pairs });
  });

  r.get("/admin/similarity/pair", async (req, res) => {
    await requireAdmin(req);
    const ids = z.tuple([z.uuid(), z.uuid()]).safeParse([req.query.a, req.query.b]);
    if (!ids.success) throw new HttpError(400, "a and b must be submission ids");
    const subs = await db.submissionsForAdmin(ids.data);
    const a = subs.find((s) => s.id === ids.data[0]);
    const b = subs.find((s) => s.id === ids.data[1]);
    if (!a || !b || a.problem_id !== b.problem_id) throw new HttpError(404, "submissions not found");
    const users = await db.distinctSubmitters(a.problem_id);
    const base = new Set([...BASE, ...(await db.commonHashes(a.problem_id, commonMin(users)))]);
    const c = compare(fingerprints(a.language as Lang, a.source), fingerprints(b.language as Lang, b.source), base);
    res.set("Cache-Control", "private, no-store");
    res.json({
      threshold: THRESHOLD,
      similarity: c.similarity,
      a: { id: a.id, login: a.login, language: a.language, verdict: a.verdict, created_at: a.created_at, source: a.source, regions: c.regionsA },
      b: { id: b.id, login: b.login, language: b.language, verdict: b.verdict, created_at: b.created_at, source: b.source, regions: c.regionsB },
    });
  });

  return r;
}
