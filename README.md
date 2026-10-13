# CodeEditor — Sandboxed Online Judge

A LeetCode-style online judge: users submit code, which is compiled and run against test cases inside locked-down, per-submission Docker containers, and receive verdicts (AC / WA / TLE / MLE / RE / CE).

> **Status:** Phase 4 complete — web frontend (Vite + React 19 + Monaco) with live judging over SSE, on top of the Phase 3 service (Express API + Valkey Streams + Go workers + Postgres). See [docs/PHASE4.md](docs/PHASE4.md).

> ⚠️ **Keep this repository private.** `problems/*/tests/` contains the **hidden test data** (inputs and expected outputs) of every problem, plus reference solutions. Anyone who can read the repo can read the hidden tests. It must stay private until Phase 6 decides where hidden tests live (for example, a separate private store mounted only on workers).

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

## Quick start
```powershell
powershell -File scripts/build-images.ps1            # build sandbox images, write images.lock.json
cd runner
go build -o judge-run.exe ./cmd/judge-run
./judge-run.exe judge --problem ../problems/ledger-total --lang cpp --src ../problems/ledger-total/solutions/ref.cpp
./judge-run.exe --lang cpp --src prog.cpp --stdin in.txt --time-limit 2s --memory-limit 256   # single run
go test ./...                                                       # unit tests
go test -p 1 -tags integration -count=1 -v ./internal/sandbox/ ./internal/judge/   # needs Docker
```

## Run the full stack locally

Prerequisites: Docker Desktop (WSL2), Go (the `runner/` module pins go1.27.2 and downloads it automatically), Node 22.

```powershell
# 0. one-time: credentials and sandbox images
copy .env.example .env                       # then set CODEJUDGE_PG_PASSWORD
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

# 4. API (terminal 2) -> http://127.0.0.1:8080
cd api; npm ci; npm start

# 5. web (terminal 3) -> http://127.0.0.1:5173  (proxies /api to the API)
cd web; npm ci; npm run dev
```

Tests (run each suite on its own on the dev machine):

| Where | Command |
|---|---|
| Go unit | `cd runner; go test ./...` |
| Go integration (Docker) | `go test -p 1 -tags integration -count=1 ./internal/sandbox/ ./internal/judge/ ./internal/store/` |
| API | `cd api; npm test` |
| Service E2E | `cd api; npm run e2e` |
| Web unit | `cd web; npm test` |
| Web E2E (Playwright; starts API + Vite + a worker) | `cd web; npx playwright install chromium; npm run e2e` |

## Dev environment
Windows 11 + Docker Desktop (WSL2 backend), Node 22. Go: `runner/go.mod` pins toolchain go1.27.2.
