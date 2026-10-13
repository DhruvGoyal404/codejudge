import { z } from "zod";

const Env = z
  .object({
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
    // Also re-enqueue submissions stuck in 'running' whose started_at is older
    // than the maximum submission duration plus margin (their worker and its
    // stream entry are gone). Fencing makes this safe even if the old worker is
    // somehow still alive. Default 30 min = Go sandbox.ReaperThreshold, which is
    // proven > MaxContainerLifetime (22.5 min) + compile.
    SWEEP_RUNNING_AFTER_MS: z.coerce.number().int().min(1_000).default(30 * 60_000),
    SSE_MAX_MS: z.coerce.number().int().min(1_000).default(30 * 60_000),
    SSE_KEEPALIVE_MS: z.coerce.number().int().min(1_000).default(15_000),
    // Safety net: each open SSE stream re-reads the DB this often, so a missed
    // judge:events entry (e.g. while the API was restarting) only delays updates.
    SSE_POLL_MS: z.coerce.number().int().min(500).default(5_000),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    // production => Secure (__Host-) cookies and GitHub credentials required.
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // The browser-facing origin. Non-GET requests must carry exactly this Origin
    // (or Referer); post-login redirects go here.
    PUBLIC_ORIGIN: z.url().transform((u) => new URL(u).origin).default("http://localhost:5173"),
    // GitHub OAuth App (api/.env). Optional outside production: without them
    // /auth/github answers 503.
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_REDIRECT_URI: z.url().default("http://localhost:5173/api/auth/github/callback"),
    // Overridable only so tests can point at a mock GitHub.
    GITHUB_OAUTH_URL: z.url().default("https://github.com"),
    GITHUB_API_URL: z.url().default("https://api.github.com"),
    // Rate limits (Valkey-backed, shared by all API instances).
    SUBMIT_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(6), // per user
    SUBMIT_LIMIT_PER_DAY: z.coerce.number().int().min(1).default(200), // per user
    AUTH_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(20), // per IP, /auth/*
    // Length of the "per minute" windows; overridden only by tests.
    RATE_LIMIT_MINUTE_S: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_PREFIX: z.string().min(1).default("rl"),
    // TEST ONLY: mounts POST /test/login (browser E2E). Allowed only with
    // NODE_ENV=test; any other NODE_ENV makes the config invalid, so the
    // server refuses to start.
    TEST_AUTH_SHORTCUT: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
    // Express "trust proxy": how req.ip (the per-IP limit key) is derived.
    // false = the socket peer. Set it (e.g. 1 or "loopback") behind a reverse
    // proxy, or every client shares the proxy's address.
    TRUST_PROXY: z
      .string()
      .default("false")
      .transform((v): boolean | number | string => (v === "false" ? false : v === "true" ? true : /^\d+$/.test(v) ? Number(v) : v)),
  })
  .superRefine((c, ctx) => {
    if (c.TEST_AUTH_SHORTCUT && c.NODE_ENV !== "test") {
      ctx.addIssue({
        code: "custom",
        path: ["TEST_AUTH_SHORTCUT"],
        message: `the test auth shortcut is only allowed with NODE_ENV=test (got ${c.NODE_ENV}); refusing to start`,
      });
    }
    if (c.NODE_ENV !== "production") return;
    for (const k of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
      if (!c[k]) ctx.addIssue({ code: "custom", path: [k], message: "required in production" });
    }
    if (c.TRUST_PROXY === false) {
      // Behind the reverse proxy every request comes from the proxy: per-IP
      // limits would put all clients in one bucket.
      ctx.addIssue({ code: "custom", path: ["TRUST_PROXY"], message: "must be set in production (1 = one proxy hop)" });
    }
    if (!c.PUBLIC_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_ORIGIN"], message: "must be https in production" });
    }
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
