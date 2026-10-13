import { createHash } from "node:crypto";

import { Router, type Response } from "express";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { newToken, parseCookies, safeEqual, type Sessions, sha256hex } from "./sessions.ts";

/** Lifetime of a login attempt (state cookie + its single-use Valkey record). */
export const OAUTH_STATE_TTL_S = 600;
const GITHUB_TIMEOUT_MS = 10_000;
const USER_AGENT = "CodeJudge";

const Callback = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(128).optional(),
  error: z.string().max(128).optional(),
});

const GitHubUser = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
  avatar_url: z.url().nullish(),
});

/**
 * Where to send the browser after login: a same-origin path only (no open
 * redirect). Anything else, including "//host", "/\host" and absolute URLs,
 * becomes "/".
 */
export function safeNext(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw.length > 512 || !raw.startsWith("/") || /[\\\u0000-\u001f]/.test(raw)) return "/";
  try {
    const u = new URL(raw, origin);
    return u.origin === origin ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

interface AuthDeps {
  db: Db;
  redis: Redis;
  sessions: Sessions;
  config: Config;
  log: Logger;
}

/**
 * Hand-written GitHub OAuth (authorization-code flow + PKCE S256, scope
 * read:user). No auth library, no JWT; the GitHub access token is used once to
 * read the user's identity and then discarded.
 *
 * Login CSRF / replay: `state` is 32 random bytes, kept in a short-lived
 * httpOnly cookie and compared to the callback's state in constant time. It is
 * also recorded in Valkey (keyed by its hash, holding the PKCE verifier) and
 * consumed with GETDEL, so each state works at most once.
 */
export function authRouter({ db, redis, sessions, config, log }: AuthDeps) {
  const r = Router();
  const stateKey = (state: string) => `auth:state:${sha256hex(state)}`;
  const fail = (res: Response, code: "state" | "denied" | "github") =>
    res.redirect(302, `${config.PUBLIC_ORIGIN}/?login_error=${code}`);
  const credentials = () => {
    const { GITHUB_CLIENT_ID: id, GITHUB_CLIENT_SECRET: secret } = config;
    if (!id || !secret) throw new HttpError(503, "GitHub login is not configured");
    return { id, secret };
  };

  r.use("/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  r.get("/auth/github", async (req, res) => {
    const { id } = credentials();
    const state = newToken();
    const verifier = newToken(); // 43 chars of base64url: a valid PKCE code_verifier
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const next = safeNext(req.query.next, config.PUBLIC_ORIGIN);
    await redis.set(stateKey(state), JSON.stringify({ verifier, next }), "EX", OAUTH_STATE_TTL_S);
    res.cookie(sessions.oauthCookieName, state, sessions.cookieOptions(OAUTH_STATE_TTL_S * 1000));
    const url = new URL("/login/oauth/authorize", config.GITHUB_OAUTH_URL);
    url.search = new URLSearchParams({
      client_id: id,
      redirect_uri: config.GITHUB_REDIRECT_URI,
      scope: "read:user",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    res.redirect(302, url.toString());
  });

  r.get("/auth/github/callback", async (req, res) => {
    const cookieState = parseCookies(req.headers.cookie).get(sessions.oauthCookieName);
    res.clearCookie(sessions.oauthCookieName, sessions.cookieOptions());
    const q = Callback.safeParse(req.query);
    if (!q.success) return fail(res, "state");
    const { code, state, error } = q.data;
    if (!state || !cookieState || !safeEqual(state, cookieState)) return fail(res, "state");
    // Consume the state before anything else can fail: it never works twice.
    const record = await redis.getdel(stateKey(state));
    if (!record) return fail(res, "state");
    const { verifier, next } = JSON.parse(record) as { verifier: string; next: string };
    if (error) return fail(res, "denied"); // e.g. access_denied: the user cancelled
    if (!code) return fail(res, "github");
    const creds = credentials();

    let gh: z.infer<typeof GitHubUser>;
    try {
      const token = await exchangeCode(code, verifier, creds);
      if (!token) return fail(res, "github");
      gh = await fetchUser(token);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "github oauth failed");
      return fail(res, "github");
    }

    const userId = await db.upsertUser(gh.id, gh.login, gh.avatar_url ?? null);
    if (req.sessionId) await db.deleteSession(req.sessionId); // no session fixation / stacking
    await sessions.create(res, userId);
    res.redirect(302, `${config.PUBLIC_ORIGIN}${next}`);
  });

  r.post("/auth/logout", async (req, res) => {
    await sessions.destroy(req, res);
    res.status(204).end();
  });

  /** Returns the access token, or null when GitHub refused the code. Never logs the response. */
  async function exchangeCode(code: string, verifier: string, creds: { id: string; secret: string }): Promise<string | null> {
    const res = await fetch(new URL("/login/oauth/access_token", config.GITHUB_OAUTH_URL), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        client_id: creds.id,
        client_secret: creds.secret,
        code,
        redirect_uri: config.GITHUB_REDIRECT_URI,
        code_verifier: verifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; error?: unknown };
    // GitHub answers 200 with {error} on failure: success is the presence of access_token.
    if (typeof body.access_token === "string" && body.access_token) return body.access_token;
    const reason = typeof body.error === "string" ? body.error.slice(0, 64) : "no access_token";
    log.warn({ reason }, "github token exchange refused");
    return null;
  }

  async function fetchUser(token: string) {
    const res = await fetch(new URL("/user", config.GITHUB_API_URL), {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`user endpoint: HTTP ${res.status}`);
    return GitHubUser.parse(await res.json());
  }

  return r;
}
