# CodeJudge

LeetCode-style online judge. Researcher (web Claude) writes specs; you implement.

## Architecture (target)

React+Monaco → API (Express+TS) → Postgres; API → Redis Streams → Go worker → sandbox containers.

## Phases

| Phase | Scope |
|---|---|
| 0 | env ✅ |
| 1 | Go sandbox runner (CLI) |
| 2 | judging + Postgres schema |
| 3 | API + Redis Streams + worker |
| 4 | frontend |
| 5 | auth/rate-limit/history |
| 6 | deploy EC2 + gVisor (runsc) + CI |
| 7 | stretch: collab mode (Yjs) |

## Dev environment

Windows 11 + Docker Desktop 4.32 (engine 27.0.3, WSL2, cgroup v2). Docker Desktop is shared with the owner's other work: NEVER modify its settings, and never touch containers/images/volumes not created by this project. All project containers carry label `judge.managed=true`.

## Sandbox invariants (never weaken without explicit approval)

- Always: `--network none`, memory+memory-swap equal, `--cpus`, `--pids-limit`, `--read-only` rootfs, `--cap-drop ALL`, `no-new-privileges`, non-root user 65534, explicit seccomp profile `sandbox/seccomp/default.json` (engine default is unconfined on this host), log driver none.
- No host bind mounts. Code and input go in as a tar stream on stdin.
- Every container is force-removed on every path (success, error, timeout, panic); a startup reaper removes stale `judge.managed` containers.
- Images pinned by digest. Compiler never present in run images.
- Untrusted output is always size-capped before being read into memory.
