import { createHash } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Limits } from "./limits.ts";
import type { Queue } from "./queue.ts";
import { requireUser } from "./sessions.ts";

/** Verdicts Insights analyzes: the program ran to completion or was stopped by a limit. */
const ANALYZABLE = new Set(["AC", "TLE", "MLE"]);

/**
 * Insights (docs/INSIGHTS.md): measured complexity of the owner's own
 * submission. Both routes are owner-only; someone else's submission looks
 * missing. Analyses are cached by (problem, language, exact code, ladder), so
 * a repeat request is free; a new analysis costs one INSIGHT_LIMIT_* point.
 * Reports carry sizes and measurements only, never program output or inputs.
 */
export function insightsRouter({ db, queue, limits, config }: { db: Db; queue: Queue; limits: Limits; config: Config }) {
  const r = Router();
  const SubmissionId = z.uuid();

  async function load(req: Parameters<Parameters<typeof r.get>[1]>[0]) {
    const user = requireUser(req);
    const id = SubmissionId.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "invalid submission id");
    const t = await db.insightTarget(id.data, user.id);
    if (!t) throw new HttpError(404, "submission not found");
    const reason = !t.ladder_hash
      ? "Insights is not available for this problem yet."
      : t.status !== "done"
        ? "Wait for the verdict first."
        : !ANALYZABLE.has(t.verdict ?? "")
          ? "Insights analyzes submissions that ran to completion: Accepted, Time Limit Exceeded or Memory Limit Exceeded."
          : null;
    const sha = createHash("sha256").update(t.source, "utf8").digest();
    const row = t.ladder_hash ? await db.getInsight(t.problem_id, t.language, sha, t.ladder_hash, config.INSIGHT_STALE_MS) : null;
    return { user, submissionId: id.data, t, reason, sha, row };
  }

  function view({ t, reason, row }: Awaited<ReturnType<typeof load>>) {
    return {
      eligible: reason === null,
      reason,
      label: t.ladder_label,
      reference: t.ladder_reference,
      status: row ? (row.stale ? "failed" : row.status) : "none",
      error: row?.stale ? "The analysis was interrupted; try again." : (row?.error ?? null),
      report: row?.status === "done" ? row.report : null,
    };
  }

  r.get("/submissions/:id/insights", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(view(await load(req)));
  });

  r.post("/submissions/:id/insights", async (req, res) => {
    const ctx = await load(req);
    const { user, submissionId, t, reason, sha, row } = ctx;
    if (reason !== null) throw new HttpError(409, reason);
    res.set("Cache-Control", "private, no-store");
    if (row && (row.status === "done" || ((row.status === "queued" || row.status === "running") && !row.stale))) {
      res.status(row.status === "done" ? 200 : 202).json(view(ctx));
      return;
    }
    await limits.consumeInsight(user.id);
    const id = await db.queueInsight(t.problem_id, t.language, sha, t.ladder_hash!, submissionId, config.INSIGHT_STALE_MS);
    if (id !== null) await queue.enqueueInsight(String(id));
    res.status(202).json(view(await load(req)));
  });

  return r;
}
