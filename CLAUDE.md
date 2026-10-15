# CodeJudge

LeetCode-style online judge. Researcher (web Claude) writes specs; you implement.

## Architecture

Target: React+Monaco → API (Express+TS) → Postgres; API → Valkey Streams → Go worker → sandbox containers.
Built so far (Phases 3–5): `web/` (Vite 8 + React 19 + Monaco, dev proxy /api → API) → `api/` (Express 5, TS) ↔ Postgres 18 + Valkey 9.1 (compose) ↔ `runner/cmd/judge-worker` (Go) → sandbox. `judge-admin import problems/` loads problem metadata + content_hash + samples; test files stay on disk for workers only. Hidden tests, generators and solutions live in the PRIVATE repo `codejudge-problems` (`$CODEJUDGE_PROBLEMS_TESTS_DIR/<slug>/{tests,gen,solutions}`); this repo has `problems/<slug>/{problem.yaml,statement.md,samples/}` only. See docs/PHASE3.md. Auth (GitHub OAuth, sessions), limits and history: docs/PHASE5.md; GitHub credentials in gitignored `api/.env` (see `api/.env.example`).

Compose (project `codejudge`, credentials in gitignored `.env`):
- `docker compose up -d --wait` · `docker compose run --rm migrate up` · `docker compose down` (volumes kept)
- Postgres 127.0.0.1:55432, Valkey 127.0.0.1:56379. Service containers carry no judge.managed label.

## Phases

| Phase | Scope |
|---|---|
| 0 | env ✅ |
| 1 | Go sandbox runner (CLI) ✅ |
| 2 | judge engine (problem format, checker, batch mode, submission verdicts) ✅ |
| 3 | API + Postgres schema + Valkey Streams + worker ✅ |
| 4 | frontend ✅ |
| 5 | auth/rate-limit/history ✅ |
| 6 | deploy EC2 + gVisor (runsc) + CI |
| 7 | stretch: collab mode (Yjs) |

## Dev environment

Windows 11 + Docker Desktop 4.32 (engine 27.0.3, WSL2, cgroup v2). Docker Desktop is shared with the owner's other work: NEVER modify its settings, and never touch containers/images/volumes not created by this project. All project containers carry label `judge.managed=true`.

Go: system 1.22.5; runner/ pins toolchain go1.27.2 via go.mod (auto-downloaded). CI must use go-version-file: runner/go.mod.

## Conventions

- Dependencies: only adopt a release that has been published for at least 14 days (check `npm view <pkg> time` / the Go module proxy); if the newest is younger, use the newest one that is older. Pin exact versions.
- Dev URLs: the browser-facing origin is `http://localhost:5173` everywhere (Vite, Playwright baseURL, `GITHUB_REDIRECT_URI`), never 127.0.0.1 — cookies are per host. Server-to-server hops (Vite proxy → API on 127.0.0.1:8080) may use 127.0.0.1.

## Sandbox invariants (never weaken without explicit approval)

- Always: `--network none`, `--ipc none`, memory+memory-swap equal, `--cpus`, `--pids-limit`, `--read-only` rootfs, `--cap-drop ALL`, `no-new-privileges`, non-root uid unique among live containers (allocator, range [1e9, 1e9+1e6), host overlap check; enforced by the atomic container name `judge-u<uid>`; RLIMIT_NPROC counts per uid), explicit seccomp profile `sandbox/seccomp/default.json` (engine default is unconfined on this host; under runsc a derived variant that only additionally allows clone3, see docs/PHASE6.md 6a.7), log driver none.
- judge-exec limits for the program: RLIMIT_NPROC (48 runc / 32 runsc, below the pids cgroup; Java/JS add `lang.ExtraTasks` to both), RLIMIT_CORE=1 (0 does not stop piped core dumps). SysV IPC and POSIX mqueues are denied by seccomp; the batch IPC guard fails closed.
- No host bind mounts. Code and input go in as a tar stream on stdin.
- Every container is force-removed on every path (success, error, timeout, panic); a startup reaper removes stale `judge.managed` containers.
- Images pinned by digest. Compiler never present in run images (java-run is a JRE: no javac). Languages: cpp, python, java (Temurin 21, class Main), javascript (Node 22); runtime heap flags = problem memory limit, container memory = limit + `lang.MemOverheadMB`; see docs/PHASE5_5.md.
- Untrusted output is always size-capped before being read into memory.
- judge-exec runs non-dumpable (PR_SET_DUMPABLE=0) and drops catchable terminating signals; batch frames are validated (nonce + seq) by the host.
- Batch mode: between tests reset /box, /tmp, /dev/mqueue and all SysV IPC objects; fail closed if any reset fails. Hidden-test output is never returned.
- Frontend: statements render with react-markdown `skipHtml` (never raw HTML); Monaco is bundled locally (no CDN) and lazy-loaded; all localStorage access is wrapped in try/catch; failed hidden tests show only number + status.
- Only sample tests may carry program stdout (DB CHECK constraint); progress events are not persisted (API replays the latest per running submission).
- Hidden tests are never served: the API has no access to test files; only samples (copied into `problem_samples` at import) are returned.
- Hidden tests, generators and solutions are NEVER committed to this (public) repo; they live only in the private problems repo. Public `samples/` must byte-match the private sample tests (loader + `judge-admin check` + CI). Docs never say which hidden test catches which bug.
- Results are written only with a fenced write (`WHERE attempt = $mine AND status = 'running'`); a stale worker discards its result and does not XACK.
- XACK only after the result commit. Events go to `judge:events` after every state change.
- Workers verify the on-disk problem content_hash against the DB before judging (mismatch → IE).
- The sweeper re-enqueues a queued submission only if `stream_entry_id` is NULL or its entry is gone from the stream; workers XACK without judging an entry for a done submission or one older than the recorded `stream_entry_id`.

## Auth invariants (never weaken without explicit approval)

- No JWT and no auth library. Sessions are opaque: the cookie holds a random 32-byte token; the DB stores only its SHA-256 (`sessions.id`), never the token. Cookie httpOnly, SameSite=Lax, Path=/; Secure + `__Host-` in production.
- OAuth `state` is random, in a short-lived httpOnly cookie, compared in constant time, and single-use (Valkey GETDEL). PKCE S256, scope `read:user`; success only if `access_token` is present; the GitHub token is never stored or logged. Never print `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` values.
- Every non-GET/HEAD/OPTIONS route passes the Origin/Referer check against `PUBLIC_ORIGIN`. Post-login `next` is same-origin paths only.
- Submission source is returned only to its owner (`GET /submissions/:id` with the owner's session); never in lists, SSE events or to anyone else.
- POST /submissions requires a session; rate limits (6/min, 200/day per user; 20/min per IP on /auth/*; 429 + Retry-After) and the 2-active cap (atomic, row lock) stay in place.
- The test auth shortcut (`TEST_AUTH_SHORTCUT=1`, `POST /test/login`) exists only with `NODE_ENV=test`; the server refuses to start otherwise. Never enable it in production or dev, never weaken that check.
- Dev machine: Docker capped at 6 GB. Run integration suites with `go test -p 1`, and each E2E suite (`api: npm run e2e`, `web: npm run e2e` / Playwright) alone; never concurrently with the benchmark or each other. Problem time limits are provisional until recalibrated on Linux (Phase 6).
