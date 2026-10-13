import { z } from "zod";

const Env = z.object({
  CODEJUDGE_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  CODEJUDGE_VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  SUBMISSIONS_STREAM: z.string().min(1).default("judge:submissions"),
  EVENTS_STREAM: z.string().min(1).default("judge:events"),
  // Simplified transactional outbox: re-enqueue submissions that are still
  // queued and were not (re)enqueued within SWEEP_AFTER_MS.
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).default(10_000),
  SWEEP_AFTER_MS: z.coerce.number().int().min(1_000).default(60_000),
  SSE_MAX_MS: z.coerce.number().int().min(1_000).default(30 * 60_000),
  SSE_KEEPALIVE_MS: z.coerce.number().int().min(1_000).default(15_000),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
});

export type Config = z.infer<typeof Env>;

/** Parses and validates configuration; throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    throw new Error("invalid configuration:\n" + z.prettifyError(r.error));
  }
  return r.data;
}
