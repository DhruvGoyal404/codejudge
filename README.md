# CodeEditor — Sandboxed Online Judge

A LeetCode-style online judge: users submit code, which is compiled and run against test cases inside locked-down, per-submission Docker containers, and receive verdicts (AC / WA / TLE / MLE / RE / CE).

> **Status:** Phase 3 complete — judge as a service: Express API + Valkey Streams + Go workers + Postgres, with fenced writes and crash recovery. See [docs/PHASE3.md](docs/PHASE3.md).

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

## Service (Phase 3)
See [docs/PHASE3.md#how-to-run](docs/PHASE3.md#how-to-run): `docker compose up -d --wait`, `docker compose run --rm migrate up`, `judge-admin import problems`, start `judge-worker` and the API (`npm start` in `api/`).

## Dev environment
Windows 11 + Docker Desktop (WSL2 backend), Node 22. Go: `runner/go.mod` pins toolchain go1.27.2.
