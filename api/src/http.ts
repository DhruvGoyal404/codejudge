import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence for cookie-authenticated requests: every non-GET/HEAD/OPTIONS
 * request must carry an Origin (or, failing that, a Referer) whose origin is
 * exactly `allowed`. A request with neither header is rejected, as is
 * `Origin: null`.
 */
export function originCheck(allowed: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin") ?? refererOrigin(req.get("referer"));
    if (origin !== allowed) throw new HttpError(403, "cross-origin request rejected");
    next();
  };
}
