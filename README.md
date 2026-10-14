# CodeEditor — Sandboxed Online Judge

A LeetCode-style online judge: users submit code, which is compiled and run against test cases inside locked-down, per-submission Docker containers, and receive verdicts (AC / WA / TLE / MLE / RE / CE).

> **Status:** Phase 5 complete — GitHub login, sessions, rate limits and submission history ([docs/PHASE5.md](docs/PHASE5.md)), on top of the Phase 4 web frontend (Vite + React 19 + Monaco, live judging over SSE) and the Phase 3 service (Express API + Valkey Streams + Go workers + Postgres).

> **Hidden test data is not in this repository.** Hidden tests (inputs and expected outputs), generators and reference/wrong/slow solutions live in the private repo `DhruvGoyal404/codejudge-problems`. This repo has only each problem's `problem.yaml`, `statement.md` and `samples/` (byte-identical copies of the sample tests). Point the tools at a checkout of the private repo with `CODEJUDGE_PROBLEMS_TESTS_DIR`. Never commit `tests/`, `gen/` or `solutions/` here: the loader refuses a public package that contains `tests/` when the variable is set. See [docs/PHASE6.md](docs/PHASE6.md) § 6a.1.

## Design principles
- One run container per submission (batch mode), reset between tests; no host bind mounts (program and inputs go in over stdin).
- Every container: `--network none`, memory/CPU/PID limits, read-only rootfs, non-root user, all capabilities dropped, `no-new-privileges`.
- Host-enforced wall-clock timeout with forced removal; capped output.
- Containers are launched with argument arrays, never shell strings.

## Docs
- [docs/AUDIT.md](docs/AUDIT.md) — audit of the original prototype (why it was rewritten).
- [docs/PHASE0.md](docs/PHASE0.md) — sandbox isolation tests on Docker Desktop (WSL2 + runc).
- [docs/PHASE1.md](docs/PHASE1.md) — sandbox runner design, test results, benchmarks.
- [docs/PHASE2.md](docs/PHASE2.md) — judge engine, security notes, seed problems, benchmarks.
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — judge-exec batch wire protocol.
- [docs/PHASE3.md](docs/PHASE3.md) — service architecture, queue semantics, end-to-end tests and latency.
- [docs/PHASE4.md](docs/PHASE4.md) — frontend, screenshots, bundle sizes, tests.
- [docs/PHASE5.md](docs/PHASE5.md) — GitHub OAuth + sessions, rate limits and the active cap, history, the test-only auth shortcut.

## Quick start
```powershell
powershell -File scripts/build-images.ps1            # build sandbox images, write images.lock.json
cd runner
go build -o judge-run.exe ./cmd/judge-run
$env:CODEJUDGE_PROBLEMS_TESTS_DIR = "<checkout of codejudge-problems>"   # hidden tests + solutions
./judge-run.exe judge --problem ../problems/ledger-total --lang cpp --src "$env:CODEJUDGE_PROBLEMS_TESTS_DIR/ledger-total/solutions/ref.cpp"
./judge-run.exe --lang cpp --src prog.cpp --stdin in.txt --time-limit 2s --memory-limit 256   # single run
go test ./...                                                       # unit tests
go test -p 1 -tags integration -count=1 -v ./internal/sandbox/ ./internal/judge/   # needs Docker
```

## Run the full stack locally

Prerequisites: Docker Desktop (WSL2), Go (the `runner/` module pins go1.27.2 and downloads it automatically), Node 22.

```powershell
# 0. one-time: credentials and sandbox images
copy .env.example .env                       # then set CODEJUDGE_PG_PASSWORD
copy api\.env.example api\.env               # then set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (see below)
powershell -File scripts/build-images.ps1    # judge sandbox images -> sandbox/images/images.lock.json

# 1. infrastructure: Postgres 18 + Valkey 9.1 (project "codejudge")
docker compose up -d --wait
docker compose run --rm migrate up

# 2. connection URLs for the Go tools and the API (values from .env)
$env:CODEJUDGE_DATABASE_URL = "postgres://codejudge:<password>@127.0.0.1:55432/codejudge?sslmode=disable"
$env:CODEJUDGE_VALKEY_URL   = "redis://127.0.0.1:56379"

# 3. problems + worker (terminal 1)
cd runner
go build -o judge-admin.exe ./cmd/judge-admin; go build -o judge-worker.exe ./cmd/judge-worker
./judge-admin.exe import ../problems
./judge-worker.exe

# 4. API (terminal 2) -> http://127.0.0.1:8080  (reads api/.env; real environment variables win)
cd api; npm ci; npm start

# 5. web (terminal 3) -> http://localhost:5173  (proxies /api to the API; use localhost, not 127.0.0.1: cookies are per host)
cd web; npm ci; npm run dev
```

**GitHub login:** create a GitHub OAuth App (Settings → Developer settings → OAuth Apps) with callback URL `http://localhost:5173/api/auth/github/callback`, exactly as `GITHUB_REDIRECT_URI`, and put its client id and secret in `api/.env` (gitignored; never commit or paste them). Browse to http://localhost:5173 and use "Log in with GitHub"; submitting requires login. Limits: 6 submissions/min and 200/day per user, at most 2 queued or running at once, 20 `/auth` requests/min per IP. Details: [docs/PHASE5.md](docs/PHASE5.md).

Tests (run each suite on its own on the dev machine):

| Where | Command |
|---|---|
| Go unit | `cd runner; go test ./...` |
| Go integration (Docker) | `go test -p 1 -tags integration -count=1 ./internal/sandbox/ ./internal/judge/ ./internal/store/` |
| API | `cd api; npm test` |
| Service E2E | `cd api; npm run e2e` |
| Web unit | `cd web; npm test` |
| Web E2E (Playwright; starts API + Vite + a worker; logs in via the test-only shortcut, `NODE_ENV=test` only) | `cd web; npx playwright install chromium; npm run e2e` |

## Dev environment
Windows 11 + Docker Desktop (WSL2 backend), Node 22. Go: `runner/go.mod` pins toolchain go1.27.2.
