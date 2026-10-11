# CodeEditor — Sandboxed Online Judge

A LeetCode-style online judge: users submit code, which is compiled and run against test cases inside locked-down, per-submission Docker containers, and receive verdicts (AC / WA / TLE / MLE / RE / CE).

> **Status:** Phase 0 — sandbox validation. No application code yet.

## Design principles
- One fresh container per run; no shared host paths (code/input delivered via `docker cp` / stdin).
- Every container: `--network none`, memory/CPU/PID limits, read-only rootfs, non-root user, all capabilities dropped, `no-new-privileges`.
- Host-enforced wall-clock timeout with forced removal; capped output.
- Containers are launched with argument arrays, never shell strings.

## Docs
- [docs/AUDIT.md](docs/AUDIT.md) — audit of the original prototype (why it was rewritten).
- [docs/PHASE0.md](docs/PHASE0.md) — sandbox isolation tests on Docker Desktop (WSL2 + runc).

## Dev environment
Windows 11 + Docker Desktop (WSL2 backend), Node 22, Go 1.22.
