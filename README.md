# CodeEditor — Sandboxed Online Judge

A LeetCode-style online judge: users submit code, which is compiled and run against test cases inside locked-down, per-submission Docker containers, and receive verdicts (AC / WA / TLE / MLE / RE / CE).

> **Status:** Phase 1 complete — Go sandbox runner (`runner/`, `judge-run` CLI). See [docs/PHASE1.md](docs/PHASE1.md).

## Design principles
- One fresh container per run; no host bind mounts (code and input go in as a tar stream on stdin).
- Every container: `--network none`, memory/CPU/PID limits, read-only rootfs, non-root user, all capabilities dropped, `no-new-privileges`.
- Host-enforced wall-clock timeout with forced removal; capped output.
- Containers are launched with argument arrays, never shell strings.

## Docs
- [docs/AUDIT.md](docs/AUDIT.md) — audit of the original prototype (why it was rewritten).
- [docs/PHASE0.md](docs/PHASE0.md) — sandbox isolation tests on Docker Desktop (WSL2 + runc).
- [docs/PHASE1.md](docs/PHASE1.md) — sandbox runner design, test results, benchmarks.

## Quick start
```powershell
powershell -File scripts/build-images.ps1            # build sandbox images, write images.lock.json
cd runner
go build -o judge-run.exe ./cmd/judge-run
./judge-run.exe --lang cpp --src prog.cpp --stdin in.txt --time-limit 2s --memory-limit 256
go test ./...                                              # unit tests
go test -tags integration -count=1 -v ./internal/sandbox/  # needs Docker
```

## Dev environment
Windows 11 + Docker Desktop (WSL2 backend), Node 22. Go: `runner/go.mod` pins toolchain go1.27.2.
