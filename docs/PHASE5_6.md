# Phase 5.6 — content: C and Go, more tests, 100 problems

Status: **0 (CI minutes) and L (C, Go) done**; T (≥45 tests per problem) and P (36 new problems) in progress. Deployment (Phase 6b) waits for this phase.

## 0. GitHub Actions minutes (report, 2026-10-17)

The repo is private: 2,000 Actions minutes/month on the free plan.

- **Used in October:** about 1,041 billable minutes across 58 runs (884 raw; billing rounds each job up to a whole minute). That counts only runs since the repo was recreated on 2026-10-14. Runs of the deleted repository still count against the quota but are not visible through the API, so the real total is higher. Exact figure: Settings → Billing, or `gh auth refresh -s user` and the billing API.
- **Where it went:**
  - push CI: 881 min over 39 runs;
  - nightly: 136 min over 3 runs (17, 51, 68 min, growing with the problem set);
  - manual dispatches: 24 min.
- **Full push run:** about 55 billable minutes (17 min wall clock). Averages per job: runsc sandbox 10.4, host-deploy 10, runc sandbox 9.1, e2e 6.2, API 2.2, Go unit 1.7, web 1, problems 1, infra 1.

Changes (`610fb32`):
- **Weekly matrix:** the full matrix runs weekly (Sunday 02:47 IST), not nightly.
- **Gated heavy jobs:** a `changes` job (GitHub compare API, no checkout) turns them on per push:
  - sandbox: `runner/`, `sandbox/`, `problems/`;
  - the runsc leg: sandbox, judge or worker internals, or the host bootstrap;
  - e2e: app code;
  - host-deploy: `deploy/`, `db/`, `judge-admin`;
  - infra: `infra/`, `deploy/host/`.
- **What still runs everything:** `ci.yml` edits, the weekly run and manual dispatch.
- **Cost now:** a docs-only push is ~8 minutes instead of ~55.

Proposed, not done:
- buildx GitHub-Actions caching of the sandbox images (~2–3 min per heavy job);
- tighter job timeouts (60–75 min today);
- pushing a problem batch's commits together, so CI runs once per batch;
- making the repo public (free standard runners); the gVisor security report would have to stay out of it.

## L. C and Go

| | C | Go |
|---|---|---|
| Compiler | gcc 14.2.0 (the pinned C++ image) | Go 1.27.2 (pinned golang image) |
| Compile | `gcc -std=c17 -O2 -pipe -static -o main main.c -lm` | `go build -p 1 -o main main.go`, `CGO_ENABLED=0`, offline |
| Run image | `cpp-run` (FROM scratch: no libc, no shell) | `cpp-run` (a static Go binary needs nothing) |
| Compile limits | default (15 s CPU, 45 s wall) | 30 s CPU, 60 s wall |
| Run environment | — | `GOMAXPROCS=1`, `GOMEMLIMIT=<limit>MiB`, `GOTRACEBACK=single` |
| Memory | the limit | the limit + 32 MB runtime overhead (`MemOverheadMB`) |
| Tasks | defaults | +16 (`ExtraTasks`) |
| Time multiplier | **1.0** | **2.0** |

### Go: build environment

Only the standard library is available. With no `go.mod`, `main.go` builds as `command-line-arguments` in module mode, so any other import fails, and `GOPROXY=off` keeps it that way. The test fixture `nonstd.go` must be CE.

**The standard library comes precompiled.** `sandbox/images/go-compile.Dockerfile` builds it once (`go build std`) into `/opt/gocache`. The sandbox uses that cache **read-only**:
- Go's attempts to write cache entries for `main.go` fail harmlessly.
- A typical build takes about 1 s; a cold cache takes about 24 s.
- The full cache is 183 MB, too big to copy into tmpfs per compile.

**The build environment must match the image exactly.** `goEnv` in `runner/internal/lang/lang.go` is identical to the image's `ENV`, because any difference changes the cache keys. `TestGoEnvMatchesImage` asserts this.

judge-exec gained `--env KEY=VALUE` (for compile and run, batch included). It extends the program's otherwise fixed environment.

### Go: runtime behaviour

- **Memory.** `GOMEMLIMIT` is a soft limit, so the GC works to stay under the problem's limit. A heap that keeps growing reaches the RSS ceiling (limit + overhead), and that is **MLE**, as is the runtime's own out-of-memory message.
- **Threads.** A Go program starts with about 3 threads, out of a budget of 64. A program with thousands of goroutines blocked in raw syscalls hits the thread limit: the runtime reports "failed to create new OS thread", and the verdict is RE. `time.Sleep` and channels need no extra threads.
- **TLE overrun.** The Go runtime handles `SIGXCPU`, so a CPU-bound Go program runs on to the hard CPU limit (+1 s) instead of stopping at the soft one. The verdict is TLE either way; it only costs one more second.
- **Extra open files.** The runtime keeps its own cgroup's CPU-limit files open for cgroup-aware GOMAXPROCS: `cpu.max` on cgroup v2 (runc), and `cpu.cfs_quota_us`/`cpu.cfs_period_us` under gVisor, which presents cgroup v1. `TestBatchFDs` allows exactly those files for Go.

### C

`-std=c17` is strict ISO C. POSIX functions (`fork`, `usleep`, `readlink`) need `#define _GNU_SOURCE` before the includes. Contest code does not need them.

### Calibration

- **Seed problems.** C and Go references were added for the five seed problems (`solutions/ref.c`, `ref.go`). All are AC, and the heaviest uses 87 ms of 3,000 ms. These problems are too light to separate the languages.
- **Workload kernels.** The multipliers therefore come from four typical heavy workloads, run in the sandbox (runc, Docker Desktop/WSL2). Each figure is the minimum CPU of three runs:

| Kernel | C++ | C | Go | Go / C++ |
|---|---|---|---|---|
| sort 10⁶ int64 (`std::sort` / `qsort` / `sort.Slice`) | 278 ms | 416 ms | 430 ms | 1.55 |
| LCS DP 9,000 × 9,000 | 433 ms | 570 ms | 827 ms | 1.9 |
| hash map, 10⁶ updates | 448 ms | 208 ms (open addressing) | 635 ms | 1.42 |
| BFS, 3·10⁵ vertices, 10⁶ edges | 815 ms | 166 ms (CSR) | 796 ms | 0.98 |

- **Go = 2.0.** That covers the worst observed ratio (DP, 1.9), so a direct Go port of a C++ solution that fits always fits. Naive solutions still TLE: the `slow.cpp` solutions run at ≥ 1.9× the limit in C++, and slower still in Go.
- **C = 1.0.** C is at least as fast as C++ except for `qsort` (1.5× `std::sort`, an indirect comparator call). C solutions are judged like C++.
- **CI re-checks this.** `TestProblems` checks every non-C++ reference against 50 % of its effective limit, weekly, for all six languages under runc and runsc.

### Tests

The sandbox matrix covers all six languages under runc and runsc:
- **Verdicts:** OK, CE (C, Go, and a non-standard Go import), RE (C segfault, Go panic), TLE (CPU and wall), MLE, OLE.
- **Integrity:** result forgery (single run and batch), threads, deep recursion, and the Go runtime's thread count.
- **Batch isolation:** descriptors, stdin over-read and hidden inputs.
- **Batch limits:** the Go run environment reaches every test, and Go out-of-memory is MLE in batch mode too.

The System V / mqueue probe is syscall-level, so its C++ and Python variants cover C and Go.
