import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { z } from "zod";

import { authRouter } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError, originCheck } from "./http.ts";
import type { Hub } from "./hub.ts";
import { Limits } from "./limits.ts";
import type { Queue } from "./queue.ts";
import { requireUser, Sessions } from "./sessions.ts";
import { testAuthRouter } from "./testAuth.ts";

export const LANGUAGES = ["cpp", "python", "java", "javascript"] as const;
export const MAX_SOURCE_BYTES = 64 * 1024;
/** At most this many of a user's submissions may be queued|running at once. */
export const MAX_ACTIVE_PER_USER = 2;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const SubmissionId = z.uuid();
const VERDICTS = ["AC", "WA", "CE", "RE", "TLE", "MLE", "OLE", "IE"] as const;
const Cursor = z.object({ t: z.string().min(1).max(64), id: z.uuid() }).strict();
const HistoryQuery = z
  .object({
    problem: Slug.optional(),
    verdict: z.enum(VERDICTS).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .max(200)
      .transform((c, ctx) => {
        try {
          return Cursor.parse(JSON.parse(Buffer.from(c, "base64url").toString("utf8")));
        } catch {
          ctx.addIssue({ code: "custom", message: "invalid cursor" });
          return z.NEVER;
        }
      })
      .optional(),
  })
  .strict();
const encodeCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");
const NewSubmission = z
  .object({
    problemSlug: Slug,
    language: z.enum(LANGUAGES),
    source: z.string().min(1),
  })
  .strict();

export interface Deps {
  db: Db;
  queue: Queue;
  hub: Hub;
  config: Config;
  log: Logger;
}

export function createApp({ db, queue, hub, config, log }: Deps) {
  const sessions = new Sessions(db, config);
  const limits = new Limits(queue.redis, config, log);
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("trust proxy", config.TRUST_PROXY);
  // The API serves only JSON and SSE, never documents: its CSP forbids
  // everything. (The page's CSP is set where the HTML is served: Caddy in
  // production, see deploy/Caddyfile and docs/PHASE6.md.)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      frameguard: { action: "deny" },
    }),
  );

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      log.info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Number(process.hrtime.bigint() - start) / 1e6 },
        "request",
      );
    });
    next();
  });
  // CSRF: reject cross-origin state-changing requests before reading the body.
  app.use(originCheck(config.PUBLIC_ORIGIN));
  // JSON body limit leaves room for escaping around a 64 KiB source; the
  // source itself is limited separately (in bytes) below.
  app.use(express.json({ limit: "200kb" }));

  app.use(sessions.middleware);

  if (config.TEST_AUTH_SHORTCUT) {
    // TEST ONLY (throws unless NODE_ENV=test). See testAuth.ts.
    log.warn("TEST AUTH SHORTCUT ENABLED: POST /test/login logs in without GitHub");
    app.use(testAuthRouter({ db, sessions, config }));
  }
  app.use("/auth", limits.auth);
  app.use(authRouter({ db, redis: queue.redis, sessions, config, log }));

  app.get("/me", (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(requireUser(req));
  });

  // My submissions: newest first, keyset pagination on (created_at, id),
  // optional problem / verdict filters. Opaque cursor = next_cursor.
  app.get("/me/submissions", async (req, res) => {
    const user = requireUser(req);
    const q = HistoryQuery.safeParse(req.query);
    if (!q.success) throw new HttpError(400, "invalid query", z.flattenError(q.error));
    const { problem, verdict, limit, cursor } = q.data;
    const rows = await db.listUserSubmissions(user.id, { problem, verdict, after: cursor, limit });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.set("Cache-Control", "private, no-store");
    res.json({
      submissions: page.map(({ cursor_t: _t, ...s }) => s),
      next_cursor: rows.length > limit && last ? encodeCursor(last.cursor_t, last.id) : null,
    });
  });

  app.get("/health", async (_req, res) => {
    const [pgOk, vkOk] = await Promise.all([
      db.ping().then(() => true, () => false),
      queue.ping().then(() => true, () => false),
    ]);
    res.status(pgOk && vkOk ? 200 : 503).json({ ok: pgOk && vkOk, postgres: pgOk, valkey: vkOk });
  });

  app.get("/problems", async (req, res) => {
    // Per-user solved/attempted badges when logged in (my_status), else null.
    res.set("Cache-Control", "private, no-store");
    res.json({ problems: await db.listProblems(req.user?.id ?? null) });
  });

  app.get("/problems/:slug", async (req, res) => {
    const slug = Slug.safeParse(req.params.slug);
    if (!slug.success) throw new HttpError(400, "invalid problem slug");
    const p = await db.getProblem(slug.data);
    if (!p) throw new HttpError(404, "problem not found");
    res.json(p);
  });

  app.post("/submissions", async (req, res) => {
    const user = requireUser(req);
    await limits.consumeSubmit(user.id); // counts every attempt, valid or not
    const body = NewSubmission.safeParse(req.body);
    if (!body.success) throw new HttpError(400, "invalid submission", z.flattenError(body.error));
    const { problemSlug, language, source } = body.data;
    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
      throw new HttpError(413, `source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    const problemId = await db.problemIdBySlug(problemSlug);
    if (problemId === null) throw new HttpError(404, "problem not found");

    // Simplified transactional outbox: the row is the source of truth. If
    // XADD fails after the INSERT, the submission stays queued with
    // enqueued_at NULL and the sweeper enqueues it later.
    const id = await db.insertSubmission(problemId, language, source, user.id, MAX_ACTIVE_PER_USER);
    if (id === null) {
      throw new HttpError(409, `at most ${MAX_ACTIVE_PER_USER} submissions may be queued or running at once`);
    }
    try {
      await db.markEnqueued(id, await queue.enqueue(id));
    } catch (err) {
      log.warn({ err, id }, "enqueue failed; sweeper will retry");
    }
    res.status(202).location(`/submissions/${id}`).json({ id });
  });

  app.get("/submissions/:id", async (req, res) => {
    const id = SubmissionId.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "invalid submission id");
    const s = await db.getSubmission(id.data);
    if (!s) throw new HttpError(404, "submission not found");
    // The source is returned only to its owner (never in SSE events).
    const source = req.user ? await db.getOwnSource(id.data, req.user.id) : null;
    res.set("Cache-Control", "private, no-store");
    res.json(source === null ? { ...s, mine: false } : { ...s, mine: true, source });
  });

  // SSE: current state first, then every change, then the final verdict; then close.
  app.get("/submissions/:id/events", async (req, res) => {
    const id = SubmissionId.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "invalid submission id");
    const first = await db.getSubmission(id.data);
    if (!first) throw new HttpError(404, "submission not found");

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let closed = false;
    let lastKey = "";
    const send = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(keepalive);
      clearInterval(poll);
      clearTimeout(maxTimer);
      res.end();
    };
    // Emit the state if it changed since the last event; close after the verdict.
    const emit = (s: NonNullable<Awaited<ReturnType<Db["getSubmission"]>>>) => {
      const key = `${s.status}|${s.verdict ?? ""}|${s.attempt}`;
      if (key !== lastKey) {
        lastKey = key;
        send("status", { id: s.id, status: s.status, verdict: s.verdict, attempt: s.attempt });
      }
      if (s.status === "done") {
        send("verdict", s);
        finish();
      }
    };
    // Serialize refreshes so events are emitted in order.
    let chain: Promise<void> = Promise.resolve();
    const refresh = () => {
      chain = chain
        .then(async () => {
          if (closed) return;
          const s = await db.getSubmission(id.data);
          if (s) emit(s);
        })
        .catch((err) => log.warn({ err, id: id.data }, "sse refresh failed"));
    };

    // Subscribe BEFORE reading/sending the current state: an update that lands
    // between the read and the subscription can't be lost.
    const sendProgress = (e: Record<string, string>) =>
      send("progress", { id: id.data, stage: e.stage, test: Number(e.test ?? 0), total: Number(e.total ?? 0) });
    const unsubscribe = hub.subscribe(id.data, (e) => {
      if (e?.stage) {
        // Progress (compiling / test k of n) is not stored in Postgres: forward it.
        sendProgress(e);
        return;
      }
      refresh();
    });
    const keepalive = setInterval(() => !closed && res.write(": keepalive\n\n"), config.SSE_KEEPALIVE_MS);
    const maxTimer = setTimeout(finish, config.SSE_MAX_MS);
    const poll = setInterval(refresh, config.SSE_POLL_MS);
    req.on("close", finish);
    emit(first);
    // A late subscriber still sees where judging is (latest progress replay).
    const latest = first.status === "running" ? hub.latestProgress(id.data) : undefined;
    if (latest) sendProgress(latest);
    refresh(); // re-read once after subscribing to cover the gap
  });

  app.use((_req, _res) => {
    throw new HttpError(404, "not found");
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.too.large") {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: "malformed JSON" });
      return;
    }
    log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

/**
 * One sweeper pass. Returns how many submissions were re-enqueued. A queued
 * submission is re-enqueued only when it has no stream entry (XADD failed) or
 * its entry is gone; one legitimately waiting in a backlog is not.
 */
export async function sweepOnce({ db, queue, config, log }: Pick<Deps, "db" | "queue" | "config" | "log">): Promise<number> {
  const rows = await db.claimForReenqueue(config.SWEEP_AFTER_MS, config.SWEEP_RUNNING_AFTER_MS, 100);
  let n = 0;
  for (const { id, status, stream_entry_id: entry } of rows) {
    try {
      if (status === "queued" && entry !== null && (await queue.hasEntry(entry))) continue; // still waiting
      await db.markEnqueued(id, await queue.enqueue(id));
      n++;
    } catch (err) {
      log.warn({ err, id }, "sweeper enqueue failed; will retry next sweep");
    }
  }
  if (n > 0) log.info({ n }, "sweeper re-enqueued stale submissions");
  return n;
}
