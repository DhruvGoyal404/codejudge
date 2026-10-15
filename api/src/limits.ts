import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";

import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";

const DAY_S = 24 * 3600;

/**
 * Fixed-window rate limits in Valkey (atomic Lua INCR + TTL), shared by every
 * API instance. Exceeding one answers 429 with Retry-After (seconds). If
 * Valkey is unavailable the limited routes fail closed (503).
 */
export class Limits {
  private readonly submitMinute: RateLimiterRedis;
  private readonly submitDay: RateLimiterRedis;
  private readonly authMinute: RateLimiterRedis;
  private readonly runMinute: RateLimiterRedis;
  private readonly runDay: RateLimiterRedis;

  constructor(
    redis: Redis,
    config: Config,
    private readonly log: Logger,
  ) {
    const mk = (name: string, points: number, duration: number) =>
      new RateLimiterRedis({ storeClient: redis, keyPrefix: `${config.RATE_LIMIT_PREFIX}:${name}`, points, duration });
    this.submitMinute = mk("submit-min", config.SUBMIT_LIMIT_PER_MIN, config.RATE_LIMIT_MINUTE_S);
    this.submitDay = mk("submit-day", config.SUBMIT_LIMIT_PER_DAY, DAY_S);
    this.authMinute = mk("auth-ip-min", config.AUTH_LIMIT_PER_MIN, config.RATE_LIMIT_MINUTE_S);
    this.runMinute = mk("run-min", config.RUN_LIMIT_PER_MIN, config.RATE_LIMIT_MINUTE_S);
    this.runDay = mk("run-day", config.RUN_LIMIT_PER_DAY, DAY_S);
  }

  /** Counts one custom-run attempt for userId (separate budget from submissions). */
  async consumeRun(userId: number): Promise<void> {
    await this.consume(this.runMinute, String(userId));
    await this.consume(this.runDay, String(userId));
  }

  /** Counts one submission attempt for userId (valid or not). */
  async consumeSubmit(userId: number): Promise<void> {
    await this.consume(this.submitMinute, String(userId));
    await this.consume(this.submitDay, String(userId));
  }

  /** Per-IP limit for /auth/*. */
  auth = async (req: Request, _res: Response, next: NextFunction) => {
    await this.consume(this.authMinute, req.ip ?? "unknown");
    next();
  };

  private async consume(limiter: RateLimiterRedis, key: string): Promise<void> {
    try {
      await limiter.consume(key);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retryAfter = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
        throw new HttpError(429, "too many requests", undefined, { "Retry-After": String(retryAfter) });
      }
      this.log.error({ err }, "rate limiter unavailable");
      throw new HttpError(503, "rate limiter unavailable");
    }
  }
}
