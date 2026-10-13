# Phase 5 — Accounts, limits, history

Status: **complete**. Users log in with GitHub; submitting requires a session; submissions are rate-limited and capped per user; users get a history, a submission detail page and a profile.

Tests, all passing: **80 API tests** (Vitest + supertest, real Postgres/Valkey, mocked GitHub), **8 service E2E tests**, **30 web unit tests**, **10 Playwright tests** (real stack, test-only auth shortcut). Manual check by the owner against the real GitHub OAuth App: login, `/me` and a submission all worked.

## 5a — GitHub OAuth and sessions

**No auth library, no JWT.** The authorization-code flow is hand-written in [`api/src/auth.ts`](../api/src/auth.ts); sessions are opaque server-side rows ([`api/src/sessions.ts`](../api/src/sessions.ts)).

| Step | What happens |
|---|---|
| `GET /auth/github[?next=/path]` | 32 random bytes of `state` and a PKCE `code_verifier`; `code_challenge = base64url(SHA-256(verifier))`, method S256. `state` goes into a 10-minute httpOnly, SameSite=Lax cookie (`cj_oauth`) **and** into Valkey as `auth:state:<sha256(state)>` → `{verifier, next}` (EX 600). Redirect to `https://github.com/login/oauth/authorize` with `scope=read:user`. |
| `GET /auth/github/callback?code&state` | Clear the state cookie. Compare query `state` with the cookie in constant time (`timingSafeEqual` over SHA-256 digests). `GETDEL` the Valkey record: a state works **once**, even if the cookie is replayed. Exchange the code (`Accept: application/json`, with `code_verifier`); success is judged **only by the presence of `access_token`** (GitHub answers 200 + `error` on failure). `GET https://api.github.com/user` once; the token is then discarded, never stored or logged. Upsert `users` by `github_id`; delete any session the browser already had; create a new session; redirect to `PUBLIC_ORIGIN + next`. |
| `POST /auth/logout` | Deletes the session row and clears the cookie: the old cookie is dead immediately. |
| `GET /me` | The session's user, or 401. |

Failures redirect to `/?login_error=state|denied|github` (the web shows a banner). `next` is restricted to same-origin paths (`safeNext`: `//host`, `/\host`, absolute URLs and control characters become `/`), so it is not an open redirect.

**Sessions:** the cookie carries a random 32-byte token (base64url); `sessions.id` is its SHA-256 hex (a CHECK constraint enforces the shape), so a leaked table can't be replayed. Cookie: httpOnly, SameSite=Lax, Path=/, and in production Secure with the `__Host-` prefix. Lifetime 30 days with sliding renewal at most once per day (one statement: a data-modifying CTE bumps `last_seen_at`/`expires_at` only when `last_seen_at` is over a day old; the cookie is re-sent only then). Expired rows are rejected on lookup and pruned by the sweeper.

**CSRF:** every non-GET/HEAD/OPTIONS request must carry `Origin` (or, failing that, `Referer`) whose origin equals `PUBLIC_ORIGIN` exactly, checked before the body is parsed. Missing, `null`, other ports and `127.0.0.1` are rejected (403). SameSite=Lax is the second layer.

**Submissions:** `POST /submissions` requires a session and records `user_id`; existing anonymous rows keep `user_id NULL`.

Schema ([`20261013000004_users_sessions.sql`](../db/migrations/20261013000004_users_sessions.sql)): `users(id, github_id UNIQUE, login, avatar_url, created_at)`, `sessions(id, user_id → users ON DELETE CASCADE, created_at, expires_at, last_seen_at)` with indexes on `user_id` and `expires_at`, `submissions.user_id` with an index on `(user_id, created_at DESC, id DESC)`.

## 5b — Limits

[`api/src/limits.ts`](../api/src/limits.ts): rate-limiter-flexible 11.2.1 `RateLimiterRedis` over the existing ioredis client (atomic Lua INCR + TTL; shared by every API instance).

| Limit | Key | Value |
|---|---|---|
| Submissions per minute | user | 6 |
| Submissions per day | user | 200 |
| `/auth/*` per minute | IP (`req.ip`; `TRUST_PROXY` behind a proxy) | 20 |

Over a limit: **429** with `Retry-After` (seconds). Every submission attempt counts (checked right after auth, before validation and insert). If Valkey is down the limited routes fail closed (503).

**Active cap:** at most **2** `queued|running` submissions per user, else **409**. Atomic: the count and the insert run in one transaction that holds the user's row `FOR UPDATE`, so concurrent requests from one user serialize. Partial index `submissions_user_active`. The concurrency tests (two POSTs at the edge, 20 rounds; a burst of 6, 10 rounds) were verified to **fail with the lock removed**.

**helmet** 8.3.0 with defaults.

## 5c — History

| Endpoint | Behaviour |
|---|---|
| `GET /me/submissions?problem=&verdict=&limit=&cursor=` | Newest first, keyset pagination on `(created_at, id)` using the `(user_id, created_at DESC, id DESC)` index. The opaque cursor carries `created_at` as **Postgres text**: a JS `Date` keeps only milliseconds and would skip or repeat rows whose timestamps differ in microseconds (the tests insert ties and 1 µs gaps). `limit` 1–100 (20). No source in rows. |
| `GET /submissions/:id` | Everyone gets the result; **only the owner** gets `source` (`mine: true`), via a separate owner-scoped query. SSE events never carry the source. |
| `GET /problems` | `my_status: solved | attempted | null` for the session user, in **one** `LEFT JOIN … GROUP BY` query (solved = any AC; attempted = submissions but no AC, including pending). |

User-dependent responses are `Cache-Control: private, no-store`.

**Web:** header login/logout (avatar + login → profile); "Log in to submit" on the problem page; API-backed "My submissions" (replaces the Phase 4 localStorage list; refreshes while pending); `/submissions/:id` with the result and, for the author, the code in a **read-only Monaco** (lazy chunk); `/profile` with solved/attempted counts, problem badges and the full history (problem/verdict filters in the URL, "Load more" over `next_cursor`); Solved/Attempted badges on the problem list; messages for 401/409/429 (with the Retry-After wait).

## 5d — Tests and the test-only auth shortcut

`TEST_AUTH_SHORTCUT=1` mounts `POST /test/login {login}` ([`api/src/testAuth.ts`](../api/src/testAuth.ts)): a throwaway user with a **negative `github_id`** (real GitHub ids are positive) and a normal session cookie. Guards:

1. Config validation rejects `TEST_AUTH_SHORTCUT=1` unless `NODE_ENV=test`: the server **refuses to start** (exit 1, "only allowed with NODE_ENV=test").
2. `testAuthRouter` throws for any other config, so a hand-built `Config` can't enable it.
3. A loud warning is logged when it is on; the Origin check still applies.

The proof is a test that runs the real entry point (`node --import tsx src/server.ts`) with the shortcut on and `NODE_ENV=development` and `production`: both exit non-zero before listening; the control run with `NODE_ENV=test` starts.

Playwright starts the API with `NODE_ENV=test TEST_AUTH_SHORTCUT=1`; a `setup` project logs in through the shortcut and saves the browser state; specs that need their own users (history, logout) create fresh ones. Teardown deletes shortcut users. GitHub itself is never contacted by tests: the API suite uses a local mock GitHub (token endpoint checks client credentials, `redirect_uri` and the PKCE verifier), and Playwright only checks the redirect to GitHub without following it.

| Suite | Count | Covers |
|---|---|---|
| `api/test/oauth.test.ts` | 16 | happy path, bad state (mismatch / no cookie / tampered / absent / array / oversized / expired record), replayed state, cancelled login, GitHub failures, expired session, logout, 503 unconfigured, prod cookies, `next` |
| `api/test/sessions.test.ts` | 11 | `/me`, hashed storage, expiry, sliding renewal, Origin/Referer check, login required |
| `api/test/limits.test.ts` | 5 | minute limit trips and resets, per-user/per-IP isolation, daily limit, helmet |
| `api/test/cap.test.ts` | 4 | active cap, concurrency |
| `api/test/history.test.ts` | 17 | pagination, filters, isolation, owner-only source, badges, single query |
| `api/test/testAuth.test.ts` | 7 | shortcut guards, real-process refusal |
| `web/e2e/auth.spec.ts` | 5 | logged-out UI, GitHub redirect, error banner, history/detail/profile/owner-only code, logout |

## Bugs found by the tests (fixed)

1. **Sweeper duplicated backlog entries** (found by the 30-submission load test): see [PHASE3.md § Follow-ups, item 5](PHASE3.md#follow-ups-after-phase-3). Fixed with `submissions.stream_entry_id`.
2. **Event consumer skipped events between XREADs:** `XREAD BLOCK … $` was re-issued after every timeout, so an event added between two reads was missed (the SSE handlers' 5 s DB poll hid it). Now the consumer resolves the stream tip once (`XREVRANGE + - COUNT 1`) and follows concrete ids; a `ready` promise replaced fixed sleeps in tests. Found when a busy machine made the fan-out test miss its event.

## Deviations and decisions

1. **State is also stored server-side** (Valkey, single-use) in addition to the httpOnly cookie, so a replayed state fails even with its cookie, and the PKCE verifier never leaves the server.
2. **`?next=`** on `/auth/github` (validated) so login returns to the page it started from.
3. **`PUBLIC_ORIGIN`** (env, default `http://localhost:5173`) is the allowed Origin and the post-login base; production requires https.
4. **Rate limits count every attempt**, including invalid bodies; a 429 happens before validation and insert.
5. **Valkey down → 503** on rate-limited routes (fail closed) rather than unlimited.
6. **The GitHub access token is not stored**; identity is read once per login.
7. **Tests shorten windows via config** (`RATE_LIMIT_MINUTE_S`), never by deleting keys; other suites raise the limits and use a per-run Valkey key prefix.
8. **Dependencies** follow the two-week rule: rate-limiter-flexible 11.2.1 (11.2.2 was too new), helmet 8.3.0.

## Configuration added

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | — | `api/.env` (gitignored; see `api/.env.example`); required in production |
| `GITHUB_REDIRECT_URI` | `http://localhost:5173/api/auth/github/callback` | must equal the OAuth App's callback exactly |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | allowed Origin; https in production |
| `NODE_ENV` | `development` | `production` → Secure `__Host-` cookies, credentials required |
| `SUBMIT_LIMIT_PER_MIN` / `_PER_DAY`, `AUTH_LIMIT_PER_MIN` | 6 / 200, 20 | |
| `RATE_LIMIT_MINUTE_S`, `RATE_LIMIT_PREFIX` | 60, `rl` | tests only change these |
| `TRUST_PROXY` | `false` | Express "trust proxy" for `req.ip` |
| `TEST_AUTH_SHORTCUT` | `0` | TEST ONLY; `1` is rejected unless `NODE_ENV=test` |

## Follow-ups for Phase 6

- Set `TRUST_PROXY` for the real reverse proxy, otherwise all clients share one per-IP bucket.
- The frontend's own CSP (helmet covers only the API's responses).
- Session cleanup runs inside the API sweeper; with several API instances it runs on each (harmless, idempotent).
