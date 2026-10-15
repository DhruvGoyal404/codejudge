import { randomUUID } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Limits } from "./limits.ts";
import type { Queue } from "./queue.ts";
import { requireUser } from "./sessions.ts";

/** Largest custom input (bytes). */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

/**
 * "Run with custom input": execute the user's code once on their own input
 * under the problem's limits, without judging. Separate from submissions:
 * nothing is stored in Postgres, there is its own rate limit (RUN_LIMIT_*),
 * and a user may have one run in progress at a time. The job and its result
 * live in a Valkey hash (RUN_KEY_PREFIX + id) for RUN_TTL_S; the worker picks
 * the id from RUNS_STREAM (runner/internal/worker/runs.go).
 */
export function runsRouter({ db, queue, limits, config, languages, maxSourceBytes }: {
  db: Db;
  queue: Queue;
  limits: Limits;
  config: Config;
  languages: readonly [string, ...string[]];
  maxSourceBytes: number;
}) {
  const r = Router();
  const redis = queue.redis;
  const key = (id: string) => `${config.RUN_KEY_PREFIX}${id}`;
  const activeKey = (userId: number) => `${config.RUN_KEY_PREFIX}active:${userId}`;
  const NewRun = z
    .object({
      problemSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      language: z.enum(languages),
      source: z.string().min(1),
      input: z.string(),
    })
    .strict();

  r.post("/runs", async (req, res) => {
    const user = requireUser(req);
    await limits.consumeRun(user.id); // counts every attempt, valid or not
    const body = NewRun.safeParse(req.body);
    if (!body.success) throw new HttpError(400, "invalid run", z.flattenError(body.error));
    const { problemSlug, language, source, input } = body.data;
    if (Buffer.byteLength(source, "utf8") > maxSourceBytes) throw new HttpError(413, `source exceeds ${maxSourceBytes} bytes`);
    if (Buffer.byteLength(input, "utf8") > MAX_RUN_INPUT_BYTES) throw new HttpError(413, `input exceeds ${MAX_RUN_INPUT_BYTES} bytes`);
    if ((await db.problemIdBySlug(problemSlug)) === null) throw new HttpError(404, "problem not found");

    // One run in progress per user.
    const prev = await redis.get(activeKey(user.id));
    if (prev) {
      const status = await redis.hget(key(prev), "status");
      if (status === "queued" || status === "running") throw new HttpError(409, "a run is already in progress");
    }
    const id = randomUUID();
    await redis
      .multi()
      .hset(key(id), { user: String(user.id), slug: problemSlug, language, source, input, status: "queued", created: new Date().toISOString() })
      .expire(key(id), config.RUN_TTL_S)
      .set(activeKey(user.id), id, "EX", config.RUN_TTL_S)
      .exec();
    await queue.enqueueRun(id);
    res.status(202).json({ id });
  });

  r.get("/runs/:id", async (req, res) => {
    const user = requireUser(req);
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "invalid run id");
    const [owner, status, result] = await redis.hmget(key(id.data), "user", "status", "result");
    // Someone else's run looks exactly like a missing one.
    if (owner !== String(user.id) || !status) throw new HttpError(404, "run not found");
    res.set("Cache-Control", "private, no-store");
    res.json({ id: id.data, status, result: result ? JSON.parse(result) : null });
  });

  return r;
}
