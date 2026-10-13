import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { CookieOptions, NextFunction, Request, Response } from "express";

import type { Config } from "./config.ts";
import type { Db, SessionUser } from "./db.ts";
import { HttpError } from "./http.ts";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Sliding renewal: last_seen_at / expires_at are bumped at most this often. */
export const SESSION_RENEW_AFTER_MS = 24 * 3600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      /** sessions.id (SHA-256 hex of the cookie token) of the current session. */
      sessionId?: string;
    }
  }
}

/** 32 random bytes, base64url (43 chars). */
export const newToken = () => randomBytes(32).toString("base64url");
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison (hashes first, so lengths need not match). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue; // first wins, like browsers send most-specific first
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    out.set(name, value);
  }
  return out;
}

export function requireUser(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, "login required");
  return req.user;
}

/**
 * Opaque server-side sessions. The cookie holds a random 32-byte token; the
 * database stores only its SHA-256, so a leaked sessions table cannot be
 * replayed. No JWTs.
 */
export class Sessions {
  readonly secure: boolean;
  readonly cookieName: string;
  readonly oauthCookieName: string;

  constructor(
    private readonly db: Db,
    config: Config,
  ) {
    this.secure = config.NODE_ENV === "production";
    // __Host- (Secure, Path=/, no Domain) is only valid over HTTPS.
    const prefix = this.secure ? "__Host-" : "";
    this.cookieName = `${prefix}cj_session`;
    this.oauthCookieName = `${prefix}cj_oauth`;
  }

  cookieOptions(maxAge?: number): CookieOptions {
    return { httpOnly: true, sameSite: "lax", secure: this.secure, path: "/", ...(maxAge ? { maxAge } : {}) };
  }

  /** Creates a session for userId and sets its cookie. */
  async create(res: Response, userId: number): Promise<void> {
    const token = newToken();
    await this.db.createSession(sha256hex(token), userId, SESSION_TTL_MS);
    res.cookie(this.cookieName, token, this.cookieOptions(SESSION_TTL_MS));
  }

  /** Deletes the current session row (if any) and clears the cookie. */
  async destroy(req: Request, res: Response): Promise<void> {
    if (req.sessionId) await this.db.deleteSession(req.sessionId);
    req.user = undefined;
    req.sessionId = undefined;
    res.clearCookie(this.cookieName, this.cookieOptions());
  }

  /** Loads req.user from the session cookie; renews at most once per day. */
  middleware = async (req: Request, res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie).get(this.cookieName);
    if (token === undefined) return next();
    const id = TOKEN_RE.test(token) ? sha256hex(token) : null;
    const s = id ? await this.db.getSession(id, SESSION_RENEW_AFTER_MS, SESSION_TTL_MS) : null;
    if (!s) {
      res.clearCookie(this.cookieName, this.cookieOptions());
      return next();
    }
    req.user = s.user;
    req.sessionId = id!;
    if (s.renewed) res.cookie(this.cookieName, token, this.cookieOptions(SESSION_TTL_MS));
    next();
  };
}
