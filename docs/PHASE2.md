# Phase 2 — Judge engine

Status: **complete**. Problem packages, host-side checkers, batch mode (one run container per submission), submission verdicts, the `judge-run judge` CLI, and 5 original seed problems are in.

All tests pass:
- unit tests;
- sandbox integration (25 tests);
- judge integration (5 problems × AC/AC/WA/TLE, plus `--run-all`).

Every suite ends with 0 containers left by its process.

> ⚠️ **All problem time limits are PROVISIONAL.** They were calibrated on Windows 11 + Docker Desktop (WSL2) under heavy host memory pressure (0.5–1.5 GB free). Recalibrate on the Linux worker in Phase 6. In particular, `farthest-beacons` was raised from 1 s to 2 s because of *per-test-mode* first-touch page-fault costs (Python reference up to 1.98 s CPU in fresh containers). In batch mode, the real path, the same reference used 0.82 s.

## Contents
1. [Security notes](#security-notes)
2. [Design](#design)
3. [Problem package format](#problem-package-format)
4. [Checkers](#checkers)
5. [Batch mode](#batch-mode) (wire protocol: [PROTOCOL.md](PROTOCOL.md))
6. [Submission verdicts and CLI](#submission-verdicts-and-cli)
7. [Seed problems](#seed-problems)
8. [Measured numbers](#measured-numbers)
9. [Deviations from the spec](#deviations-from-the-spec)

---

## Security notes

### S1. Result forgery via `/proc/1/fd/1` (found and fixed in A1)

**What was possible.** The judged program and `judge-exec` (PID 1) run as the same uid (65534). On Linux, a process may open another same-uid process's `/proc/<pid>/fd/*` if the target is *dumpable*, and `judge-exec` was. A program could therefore `open("/proc/1/fd/1", O_WRONLY)` and write arbitrary bytes into judge-exec's own stdout, which is the channel the host reads results from. The same access would also have allowed `ptrace`/`process_vm_writev` against PID 1, i.e. rewriting judge-exec's memory. The default seccomp profile allows `ptrace` on kernels ≥ 4.8.

**How it was found.** The spec's A1 scenario was "a forked child writes a fake frame after the parent exits". That scenario was already defeated by ordering: `kill(-1)` and reap happen before the frame is written. I extended the fixture (`testdata/forge.{cpp,py}`) to also try the stronger route, writing through `/proc/1/fd/1` *before* exiting, and ran it against the unmodified judge-exec. The host received the injected bytes (`parse result frame: invalid character 'J'`, from the fake `JFR1` header). The outcome was IE rather than a forged OK only because the single-run host happens to reject a buffer holding two JSON values. A batch-mode host reading length-prefixed frames could have accepted an injected frame.

**Fix (commit `a71e583`).**
- `judge-exec` calls `prctl(PR_SET_DUMPABLE, 0)` at startup. `/proc/1/*` becomes root-owned, and ptrace/`process_vm_*` access is denied to non-`CAP_SYS_PTRACE` processes (all capabilities are dropped). `execve` resets dumpability for the re-exec child and the program, so `/proc/<child>/status` measurements still work.
- `judge-exec` installs a handler that drops SIGTERM/INT/HUP/QUIT/USR1/USR2/ALRM/VTALRM/PROF. In a PID namespace the kernel only delivers to init those signals it has a handler for, and Go installs exit-on-signal handlers by default, so a program could otherwise kill PID 1 to force an IE. A handler is used rather than `SIG_IGN`, so children get default dispositions after `execve`.
- **Batch frames carry a per-container nonce and a seq.** The host rejects any frame with the wrong nonce or an unexpected seq: the verdict becomes IE and the container is force-removed. The program never sees the nonce.

**Regression tests:** `TestVerdictForgery` (single-run) and `TestBatchVerdictForgery` (batch), C++ and Python. Both give RE (exit 3); stderr shows `open /proc/1/fd/1: Permission denied`; the delayed child never writes; in batch mode the next test still runs with valid frames.

### S2. Descriptor inheritance

The program's fds 0/1/2 are `/box/input`, `/box/.stdout` and `/box/.stderr`, opened per test. Everything else `judge-exec` holds is close-on-exec (Go's default), and the container stdin carrying the protocol is never passed down.

`TestBatchFDs` (C++/Python) lists `/proc/self/fd` from inside the program. Observed: only `0 -> /box/input`, `1 -> /box/.stdout`, `2 -> /box/.stderr`, plus the `/proc/<pid>/fd` directory being listed. No pipes, sockets or anon inodes.

### S3. Reading past the end of stdin

`TestBatchStdinOverread` (C++/Python): the program reads its input to EOF, then retries 20 times over 1 s. Every test returned `own=MARK-n extra=0`. Bytes of a later test are never readable: the program's stdin is a file, and the host sends test *n+1* only after receiving the result frame of test *n*.

### S4. Hidden inputs and cross-test state

| Channel | Mechanism | Verified by |
|---|---|---|
| Later tests' inputs | Never in the container before their turn (sent one at a time, after the previous result) | `TestBatchHiddenInputs`: a snooper walking `/box`, `/tmp` and `/dev/shm` sees only its own input |
| Files in `/box`, `/tmp` | Reset after every test; program files re-extracted from judge-exec's in-memory copy before every test, so the program cannot modify its own binary across tests | same test: files written as "LEFTOVER" are never found later |
| `/dev/shm` | `--ipc none` on every container: **not mounted** (planting fails with ENOENT) | `TestBatchCrossTestState` |
| POSIX message queues | Under `--ipc none` Docker **still mounts `/dev/mqueue`** and `mq_open(O_CREAT)` succeeds, so `/dev/mqueue` is reset after every test | `TestBatchCrossTestState`: queue planted in test 1, absent in tests 2–3 |
| SysV shm / msg / sem | After every test, judge-exec reads `/proc/sysvipc/{shm,msg,sem}`, removes every object with `IPC_RMID` (shmctl/msgctl/semctl), then re-reads to verify the tables are empty. **A failed removal ends the batch with an error frame**, the same as a failed wipe | `TestBatchCrossTestState` (C++): segment, queue and semaphore set with fixed keys planted in test 1, absent in tests 2–3. Unit test `ipc cleanup fails after run` |
| Python coverage | `sysv_ipc` (third-party) is **not available** in the run image (`find_spec` → False), and CPython has no POSIX-mqueue API. The Python variant covers the filesystem-visible channels (`/dev/shm`, `/dev/mqueue`); SysV is covered by the C++ variant | `snoopipc.py` output |
| Output of hidden tests | Never returned in the submission result; only samples' stdout/stderr/expected (capped at 4 KiB) | `TestRunAllAndSampleFirst` |

Expected outputs never enter any container: checkers run on the host only.

### S5. Container death and protocol violations

- A failed stdin write, a broken result stream or a missed per-test host guard (wall + 5 s) is treated as container death. The host waits for the container to stop, reads `State.OOMKilled` (MLE if set, else IE), and force-removes it. The batch is marked dead and never reused (`TestBatchContainerDeath`: external `docker kill` mid-batch → IE, next `Run` refused, container gone).
- A genuine judge-exec error frame (correct nonce, `status=error`) → IE with judge-exec's message; the batch ends (`TestBatchOversizedInput`).
- **The reaper** (`a71e583`) removes only containers whose owning runner process is dead (labels `judge.instance`/`judge.host`/`judge.pid`/`judge.pid_start`; pid liveness **and** start time, so pid reuse is detected), or containers older than **ReaperThreshold = 30 min**. A unit test proves that is strictly greater than **MaxContainerLifetime = 22 min 30 s**:
  - batch: 20 s startup grace + 50 tests × (21 s wall at the 10 s max effective time limit + 5 s guard) + 30 s removal;
  - compile: 1 min 35 s;
  - single run: 1 min 11 s.

---

## Design

```
judge-run judge ─► judge.Judge ─► Sandbox.Compile ─► compile container ─► artifact (or CE)
                                └► Sandbox.StartBatch ─► ONE run container ─► P (nonce ‖ program tar)
                                     for each test (samples first):
                                       Batch.Run(input) ─► T message ─► JFR1 frame ─► validate nonce/seq
                                       ─► classify ─► checker (host) ─► AC/WA/…
                                       stop at first non-AC unless --run-all; stop if the batch died
                                   Batch.Close ─► E message, force-remove
```

| Package | Responsibility |
|---|---|
| `internal/problem` | Load and validate problem packages |
| `internal/checker` | exact / tokens / float comparison (host only) |
| `internal/protocol` | Batch framing (`framing.go`) and the result `Frame` |
| `cmd/judge-exec` | `batch.go` (portable loop, unit-tested with fakes), `run.go` (runOne/reapAll/emitResult, refactored from Phase 1 with no behaviour change), `workdir.go` (resetWorkDir), `ipc_linux.go` (SysV cleanup) |
| `internal/sandbox` | `batch.go` (host batch runner), shared `containerConfigs` (single-run and batch containers get identical hardening, now including `--ipc none`) |
| `internal/judge` | Submission orchestration and aggregation; `--mode per-test` keeps the Phase 1 container-per-test path as the benchmark baseline |

## Problem package format

```
problems/<slug>/problem.yaml   id, title, time_limit, memory_limit, checker, time_multiplier, samples
problems/<slug>/statement.md
problems/<slug>/tests/NN.in, NN.out
problems/<slug>/gen/           deterministic generator(s)
problems/<slug>/solutions/     ref.cpp, ref.py, wrong.cpp, slow.cpp
```

**Validation on load** (`problem.Load`):
- Unknown YAML fields are rejected.
- `id` must equal the directory name.
- `time_limit` ≤ 5 s; `memory_limit` 16–1024 MB; `time_multiplier` per language ≤ 5 (defaults cpp 1.0, python 2.0); the effective limit must be ≤ 10 s.
- Checker config is validated.
- `statement.md` must be non-empty.
- Every `.in` needs a `.out` and vice versa; only `NN.in` / `NN.out` files are allowed.
- 1–50 tests; ≤ 16 MiB per file and ≤ 64 MiB in total.
- Samples must exist and be unique.
- Tests are ordered with samples first (in YAML order), then the rest by name.

Test files are marked `-text` in `.gitattributes` so they stay byte-exact on every checkout.

## Checkers

Host-side only. Mismatch messages are short (excerpts ≤ 48 bytes).

| Type | Rule |
|---|---|
| `exact` | Byte-equal after CRLF→LF and stripping trailing newlines |
| `tokens` (default) | Whitespace-separated tokens equal (allocation-free tokenizer, no 64 KiB token limit) |
| `float` | Tokens; numeric tokens equal within `abs_eps` **or** `rel_eps`; NaN matches only NaN, ±Inf only the same infinity, overflowing literals parse as ±Inf; non-numeric tokens exact |

Unit tests cover empty output, extra/missing tokens, CRLF, NaN/Inf/−0, overflow, a 1 M-token output and a single 10 MiB token.

## Batch mode

The full wire format is in [PROTOCOL.md](PROTOCOL.md).

- **Container:** one run container per submission, `StdinOnce=false`. The initial `P` message carries a 16-byte nonce plus a tar of **only the program files**.
- **Per test (judge-exec):** re-extract the program files, write `/box/input` (0400), `runOne` (fresh rlimits each time), `reapAll`, reset `/box`, `/tmp` and `/dev/mqueue`, remove SysV IPC objects, emit the frame (`seq`, `nonce`).
- **Errors:** any protocol error, failed reset or failed IPC removal → error frame, non-zero exit.
- **Host:** per-test guard `WallLimit(TL) + 5 s` and a batch deadline (`20 s + n·(wall + 5 s)`); frames are validated (S1); death is handled as in S5.
- **Batch memory:** problem limit + 24 MB helper + program size (judge-exec keeps a copy) + `/box` size + 16 MB `/tmp`.

## Submission verdicts and CLI

**Verdicts:** AC / WA / CE / RE / TLE / MLE / OLE / IE. A run status of OK becomes AC or WA via the checker.

**Result fields:**
- the verdict and its reason;
- the first failing test's name, 1-based index and whether it's a sample;
- tests run / total;
- `max_cpu_ms` and `max_rss_kb` across the executed tests;
- the effective time limit;
- compile output and timings;
- per-test details.

```
judge-run judge --problem problems/<slug> --lang cpp|python --src FILE [--run-all] [--mode batch|per-test]
```

- **Stopping:** stop at the first non-AC test by default; `--run-all` continues, but a dead container still ends the submission.
- **Compatibility:** `judge-run [run] …` (Phase 1 single run) still works.

## Seed problems

All five are original statements. Each has 2 samples plus hidden tests, generated deterministically (the generators, hidden tests and solutions live in the private problems repo since Phase 6a). Expected outputs come from the Python reference (`scripts/make-tests.py`) and are cross-checked by the C++ reference getting AC. `farthest-beacons` is also brute-force-checked on random cases.

Each problem has a deliberately wrong and a deliberately slow solution; the integration suite requires ref.cpp / ref.py / wrong.cpp / slow.cpp to get AC / AC / WA / TLE. (Which test catches which mistake is not documented: that would describe the hidden tests.)

| Problem | Task | Wrong solution's mistake | Slow solution | Integration result |
|---|---|---|---|---|
| ledger-total | 64-bit sum | 32-bit accumulator | O(n²) prefix recomputation | AC / AC / WA / TLE |
| range-ledger | range sums | off-by-one (already fails sample 01) | O(n·q) | AC / AC / WA / TLE |
| courier-grid | grid BFS | wrong value for unreachable cells | quadratic Jacobi relaxation | AC / AC / WA / TLE |
| rising-towers | strict LIS | non-strict comparison (`upper_bound`) | O(n²) DP | AC / AC / WA / TLE |
| farthest-beacons | diameter of a point set (float) | distances from one point only | all pairs O(n²) | AC / AC / WA / TLE |

The slow solutions are asymptotically slower: ~5·10⁹ to 3·10¹⁰ steps on the large tests. They TLE via SIGXCPU at about 2.1 s of CPU at TL 1 s, or 3.2 s at TL 2 s.

### Python reference: max `cpu_ms` per problem (batch mode, all tests)

Effective limit = base × 2.0. The integration test asserts ≤ 50% of it.

| Problem | Effective limit | 2026-10-12 (first run) | 2026-10-13 (after `.wslconfig` cap, run alone) |
|---|---|---|---|
| ledger-total | 2000 ms | 34 ms | 76 ms |
| range-ledger | 2000 ms | 136 ms | 420 ms |
| courier-grid | 2000 ms | 235 ms | 520 ms |
| rising-towers | 2000 ms | 67 ms | 161 ms |
| farthest-beacons | 2000 ms → **4000 ms** | 821 ms (of 2000) | 1438 ms (36%) |

CPU time on this host swings by 2–3× with memory pressure and concurrent load. When the sandbox and judge suites accidentally ran in parallel, `farthest-beacons` reached 2033 / 4000 ms. **Run integration suites with `-p 1` and never alongside the benchmark.**

## Measured numbers

> **Context:** the benchmark was recorded at **0.6–0.7 GB free host RAM** (Docker Desktop: 12 CPUs, ~7.6 GB, no `.wslconfig` cap). The farthest-beacons/Python/per-test row was re-run on 2026-10-13 with `.wslconfig` capping Docker at 6 GB / 6 CPUs, with 0.5 → 1.3 GB free. **Treat the batch-vs-per-test ratio as the finding, not the absolute times.**

### Per test inside a batch vs per-test containers

- **Inside a batch:** 5–35 ms per test on the host (send input → validated frame), for small programs (`TestBatchOK`, `TestBatchFDs`).
- **One container per test (Phase 1):** ~0.7–3 s per test, as measured in Phase 1.

### Full submission latency (compile + all tests), 10 runs each, reference solutions

| Problem (tests) | C++ batch p50 / p95 | C++ per-test p50 / p95 | Python batch p50 / p95 | Python per-test p50 / p95 |
|---|---|---|---|---|
| ledger-total (11) | 1.66 s / 1.97 s | 11.10 s / 28.05 s | 1.68 s / 2.61 s | 7.34 s / 16.13 s |
| range-ledger (10) | 2.58 s / 6.50 s | 6.76 s / 12.24 s | 11.18 s / 15.26 s | 15.65 s / 18.97 s |
| courier-grid (10) | 4.73 s / 11.47 s | 26.35 s / 57.40 s | 5.69 s / 7.47 s | 13.01 s / 21.46 s |
| rising-towers (10) | 4.64 s / 7.43 s | 12.05 s / 17.22 s | 3.44 s / 3.70 s | 10.09 s / 12.88 s |
| farthest-beacons (10) | 4.90 s / 5.35 s | 14.19 s / 40.75 s | 9.22 s / 11.02 s | 19.54 s / 26.27 s ¹ |

¹ Re-run on 2026-10-13 at TL 2 s, under the changed Docker resources described above. In the original run this combination produced a TLE: in fresh per-test containers the Python reference used up to 1.98 s CPU against the then-1 s base limit. That is what triggered the time-limit raise.

**Finding:** batch mode is faster in every combination. The p50 speed-up is **≈ 2.6–6.7× for C++** (it no longer ships the ~2.5 MB static binary through the Windows named pipe once per test, nor pays container setup per test) and **≈ 1.4–4.4× for Python**. The two Python rows with the smallest gain (range-ledger, farthest-beacons) are dominated by the program's own CPU time on the large tests, which batch mode doesn't change. The p95 spread (up to 57 s) reflects the host memory pressure.

## Deviations from the spec

1. **Program files re-extracted before every test.** The spec's loop wipes the work dir after each test, which would delete the program. judge-exec keeps the program tar in memory and re-extracts it each time, which also stops a program from modifying its own binary across tests.
2. **More directories reset than just the work dir:** `/tmp` and `/dev/mqueue` (plus `/dev/shm` if present), and SysV IPC objects are removed (S4).
3. **`resetWorkDir` lives in a portable `workdir.go`, and shared declarations in `types.go`,** not in `run.go`. `run.go` is Linux-only, and keeping the batch loop and `resetWorkDir` portable lets their unit tests run on the Windows dev host.
4. **Error frames.** A judge-exec error frame with the correct nonce is reported as IE with its own message even when its seq is the previous test's (judge-exec rejected the input before starting the test). Any other nonce/seq mismatch is a protocol violation → IE.
5. **A clean EOF on the protocol stdin is treated like `E`,** as specified in PROTOCOL.md.
6. **`--ipc none` is applied to all sandbox containers,** compile included, not only run containers.
7. **Wrong and slow solutions are all C++,** so that WA/TLE can't be confused with Python slowness.
8. **Large tests use n = 10⁵** (not the 2·10⁵ given as an example) to keep the repository at about 16 MB of test data. The slow solutions still need ≥ 5·10⁹ steps and TLE reliably.
9. **The exact checker strips *all* trailing newlines,** not just one.
10. **`farthest-beacons` time limit is 2 s** (see the PROVISIONAL note at the top).
11. **The Python "clear margin" is enforced as ≤ 50%** of the effective limit, asserted in `TestSeedProblems`.
12. **Post-suite leak checks count only the current process's containers** (`judge.instance` label), so a concurrently running suite can't trip them. The reaper's behaviour is unchanged.

## Commits (Phase 2)

| Commit | Content |
|---|---|
| `a71e583` | Forgery hardening (S1), instance-aware reaper, lifetime proof |
| `d4894f8`, `5f9b779` | Problem loader, checkers, formatting |
| `b3b062a` | Batch framing + PROTOCOL.md |
| `40f6d63` | judge-exec refactor (no behaviour change) |
| `65d45b2` | judge-exec batch mode |
| `8d5eca2` | Host batch runner, frame validation, isolation tests |
| `5e4b93b` | Submission verdicts + `judge-run judge` |
| `4c92d69`, `a558577` | Seed problems; byte-exact test files |
| `71b01ef` | `--ipc none`, SysV/mqueue cleanup, cross-test-state test |
| `3869178` | farthest-beacons TL 2 s (provisional) |
| `81725fb` | Benchmark test |
