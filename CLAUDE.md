# CodeJudge

LeetCode-style online judge. Researcher (web Claude) writes specs; you implement.

## Architecture

Target: React+Monaco → API (Express+TS) → Postgres; API → Valkey Streams → Go worker → sandbox containers.
Built so far (Phases 3–4): `web/` (Vite 8 + React 19 + Monaco, dev proxy /api → API) → `api/` (Express 5, TS) ↔ Postgres 18 + Valkey 9.1 (compose) ↔ `runner/cmd/judge-worker` (Go) → sandbox. `judge-admin import problems/` loads problem metadata + content_hash + samples; test files stay on disk for workers only. See docs/PHASE3.md.

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
| 5 | auth/rate-limit/history |
| 6 | deploy EC2 + gVisor (runsc) + CI |
| 7 | stretch: collab mode (Yjs) |

## Dev environment

Windows 11 + Docker Desktop 4.32 (engine 27.0.3, WSL2, cgroup v2). Docker Desktop is shared with the owner's other work: NEVER modify its settings, and never touch containers/images/volumes not created by this project. All project containers carry label `judge.managed=true`.

Go: system 1.22.5; runner/ pins toolchain go1.27.2 via go.mod (auto-downloaded). CI must use go-version-file: runner/go.mod.

## Sandbox invariants (never weaken without explicit approval)

- Always: `--network none`, `--ipc none`, memory+memory-swap equal, `--cpus`, `--pids-limit`, `--read-only` rootfs, `--cap-drop ALL`, `no-new-privileges`, non-root user 65534, explicit seccomp profile `sandbox/seccomp/default.json` (engine default is unconfined on this host), log driver none.
- No host bind mounts. Code and input go in as a tar stream on stdin.
- Every container is force-removed on every path (success, error, timeout, panic); a startup reaper removes stale `judge.managed` containers.
- Images pinned by digest. Compiler never present in run images.
- Untrusted output is always size-capped before being read into memory.
- judge-exec runs non-dumpable (PR_SET_DUMPABLE=0) and drops catchable terminating signals; batch frames are validated (nonce + seq) by the host.
- Batch mode: between tests reset /box, /tmp, /dev/mqueue and all SysV IPC objects; fail closed if any reset fails. Hidden-test output is never returned.
- Frontend: statements render with react-markdown `skipHtml` (never raw HTML); Monaco is bundled locally (no CDN) and lazy-loaded; all localStorage access is wrapped in try/catch; failed hidden tests show only number + status.
- Only sample tests may carry program stdout (DB CHECK constraint); progress events are not persisted (API replays the latest per running submission).
- Hidden tests are never served: the API has no access to test files; only samples (copied into `problem_samples` at import) are returned.
- Results are written only with a fenced write (`WHERE attempt = $mine AND status = 'running'`); a stale worker discards its result and does not XACK.
- XACK only after the result commit. Events go to `judge:events` after every state change.
- Workers verify the on-disk problem content_hash against the DB before judging (mismatch → IE).
- Dev machine: Docker capped at 6 GB. Run integration suites with `go test -p 1`, and each E2E suite (`api: npm run e2e`, `web: npm run e2e` / Playwright) alone; never concurrently with the benchmark or each other. Problem time limits are provisional until recalibrated on Linux (Phase 6).
