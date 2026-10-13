import { randomInt } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Sessions } from "./sessions.ts";

const Body = z.object({ login: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict();

/**
 * TEST-ONLY auth shortcut for browser E2E tests: POST /test/login {login}
 * creates a throwaway user (negative github_id, which real GitHub accounts
 * never have) and a normal session cookie, skipping GitHub.
 *
 * Mounted only when TEST_AUTH_SHORTCUT=1, which config validation rejects
 * unless NODE_ENV=test (the server refuses to start); this function checks
 * again so a hand-built Config cannot enable it either.
 */
export function testAuthRouter({ db, sessions, config }: { db: Db; sessions: Sessions; config: Config }) {
  if (!config.TEST_AUTH_SHORTCUT || config.NODE_ENV !== "test") {
    throw new Error("test auth shortcut requires NODE_ENV=test and TEST_AUTH_SHORTCUT=1");
  }
  const r = Router();
  r.post("/test/login", async (req, res) => {
    const body = Body.safeParse(req.body);
    if (!body.success) throw new HttpError(400, "invalid body");
    const githubId = -randomInt(1, 2 ** 47);
    const userId = await db.upsertUser(githubId, `e2e-${body.data.login}`, null);
    if (req.sessionId) await db.deleteSession(req.sessionId);
    await sessions.create(res, userId);
    res.json({ id: userId, github_id: githubId, login: `e2e-${body.data.login}` });
  });
  return r;
}
