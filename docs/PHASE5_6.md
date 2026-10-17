# Phase 5.6 — content: C and Go, more tests, 100 problems

Status: **done**: 0 (CI minutes), L (C, Go), T (≥45 tests per problem), P (100 problems). Deployment (Phase 6b) is next.

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

## T. At least 45 tests per problem

- **Every problem gained 17–22 new cases**, written per problem by hand into `gen/gen.py`. They are appended after the existing ones, so `01`/`02` (the public samples) and every earlier test are unchanged. The tooling is `tools/more_tests.py` and `tools/tests56/` in the private repo.
- **What the new cases cover:**
  - minimum sizes;
  - duplicates and ties;
  - value extremes and 32-bit overflow boundaries;
  - exhaustive tiny random cases;
  - medium random cases;
  - inputs that break common wrong approaches: greedy choices, naive restarts in string matching, quadratic scans, a missing modulo for negative numbers, double rounding.
- **Size.** New cases are small or medium. Problems that already had several maximum-size tests got none.
- **Same rules as before.** Every input passes its validator, `ref.cpp` and `ref.py` agree byte for byte, and every problem stays under the 32 MiB / 50-test caps. `farthest-beacons`' `ref.py` now rounds the square root exactly (integer square root): a double sqrt differed from `ref.cpp`'s long double in the sixth decimal on one new test.
- **The minimum is enforced.** `CatalogMinTests` (and `make-tests.py`) is now 45, checked by `judge-admin check` and `TestProblems`.
- **Packed size** of codejudge-problems: **244.06 MiB → 272.46 MiB** (`git count-objects`, after `git gc`). The CI warning threshold is 500 MiB.
- **Headroom.** Python references stay far from their limits: the heaviest uses 19 % on Linux CI (market-stalls, before T). The new cases are smaller than each problem's existing maximum.

## P. 36 new problems: 100 in all

The final mix is **30 easy / 45 medium / 25 hard**: 7 / 16 / 13 new, on top of 23 / 29 / 12. The problems were added in batches 8–11 (nine each), with CI after each batch.

Every new problem meets the same bar as before:
- an original statement;
- a seeded generator and a strict validator;
- 45+ tests, at most a handful at the maximum size;
- `ref.cpp` and `ref.py` agreeing byte for byte;
- for medium and hard problems, a slow solution that must TLE;
- a wrong solution that must WA;
- the Python reference within 50 % of its effective limit.

The 50 % rule was checked on the local Docker Desktop host. Its CPU times run about 4× Linux CI, so it is the stricter check.

New tags: `fenwick-tree`, `meet-in-the-middle`, `sparse-table`, `binary-lifting`.

| Title | Difficulty | Tags | Limit | Tests | Summary |
|---|---|---|---|---|---|
| Dock Crates | easy | stack, implementation | 1 s | 45 | Stack of crates with top and heaviest queries (running maximum). |
| Tandem Bikes | easy | two-pointers, sorting | 1 s | 45 | Count pairs with a_i + a_j <= K. |
| Telegraph Runs | easy | strings, implementation | 1 s | 45 | Run-length encode a message. |
| Lamp Panel | easy | bit-manipulation | 1 s | 45 | Popcount, lowest set bit, clear it, for 63-bit numbers. |
| Leaderboard | easy | sorting, implementation | 1 s | 45 | Sort by score then name; competition ranking (1, 2, 2, 4). |
| Spiral Tour | easy | matrix, simulation | 1 s | 45 | Clockwise spiral order of a grid. |
| Field Sums | easy | prefix-sums, matrix | 1 s | 45 | Rectangle sums with 2D prefix sums. |
| Queue Swaps | medium | fenwick-tree, sorting | 2 s | 45 | Minimum adjacent swaps = inversions (equal tickets never swap). |
| Swamp Crossing | medium | bfs, shortest-paths | 1 s | 45 | Fewest swamp cells on a grid route: 0-1 BFS. |
| Radio Masts | medium | binary-search, greedy | 1 s | 45 | Smallest integer range so k masts cover all houses. |
| Rail Fares | medium | shortest-paths, graphs | 2 s | 45 | All-pairs cheapest fares (Floyd–Warshall), 1e5 questions. |
| Ridge Lookout | medium | sparse-table, arrays | 1 s | 45 | Range maximum and its first position (sparse table). |
| Critical Roads | medium | graphs, dfs | 2 s | 46 | Count bridges and articulation points; parallel roads and loops. |
| Festival Guards | medium | dynamic-programming, trees | 2 s | 45 | Maximum-weight independent set on a tree. |
| Rope Joining | medium | dynamic-programming, intervals | 1 s | 47 | Merge neighbouring ropes at minimum cost (interval DP). |
| Fence Posts | medium | geometry, sorting | 2 s | 46 | Convex hull: corner count and twice the area (128-bit). |
| Stepping Ledges | medium | dynamic-programming, sliding-window, queue | 1 s | 45 | Best score with jumps of at most k: monotonic-queue DP. |
| Ancestor Lookup | medium | trees, binary-lifting | 3 s | 45 | k-th ancestor queries. |
| Mirror Cuts | medium | dynamic-programming, strings | 1 s | 46 | Fewest cuts into palindromes. |
| Snow Paths | medium | dynamic-programming, matrix | 1 s | 45 | Count right/down/diagonal routes around rocks, mod 1e9+7. |
| Subset Tally | medium | meet-in-the-middle, two-pointers, sorting | 1 s | 46 | Count subsets with total weight <= W (n <= 36). |
| Distinct Snippets | medium | hashing, strings | 2 s | 45 | Distinct substrings of length k (rolling hash; C++ uses a suffix array). |
| Summit Pass | medium | binary-search, union-find, graphs | 2 s | 45 | Minimise the steepest step on a grid route. |
| Billboard Strip | hard | segment-tree | 2 s | 45 | Range assign and range sum: lazy segment tree. |
| Lucky Plates | hard | dynamic-programming, math | 1 s | 49 | Count numbers in [L, R] (R <= 1e18) with no equal neighbouring digits and digit sum divisible by D: digit DP. |
| Treasure Weights | hard | meet-in-the-middle, sorting, binary-search | 2 s | 45 | 0/1 knapsack with huge weights, n <= 36. |
| Signal Hub | hard | trees, dynamic-programming, dfs | 2 s | 45 | Sum of distances from every node (rerooting). |
| Trail Markers | hard | trees, binary-lifting | 3 s | 45 | k-th node on a tree path (LCA + binary lifting). |
| Echo Palindromes | hard | strings | 2 s | 45 | Count palindromic substrings (Manacher), up to 1.25e11. |
| Toll Passes | hard | dynamic-programming, matrix | 1 s | 45 | Cheapest grid route with K toll waivers. |
| Harbour GCD | hard | number-theory, math, arrays | 1 s | 45 | Count subarrays with gcd exactly g. |
| Flood Bridges | hard | graphs, dfs, binary-lifting | 2 s | 45 | Bridges separating u and v: bridge tree + LCA. |
| Bulk Cargo | hard | dynamic-programming, queue, sliding-window | 2 s | 45 | Bounded knapsack with a monotonic queue. |
| Hatchery Costs | hard | dynamic-programming, geometry | 1 s | 45 | Group ponds at K + span² each: convex hull trick. |
| Toll Upgrades | hard | shortest-paths, graphs, dynamic-programming | 2 s | 45 | Sum of all-pairs distances after each new road (incremental Floyd–Warshall). |
| Bracket Repair | hard | dynamic-programming, strings, intervals | 1 s | 45 | Fewest insertions to balance ()[]{} (interval DP). |

The multipliers are the defaults (C 1.0, C++ 1.0, Go 2.0, Python 2.0, Java 2.0, JavaScript 2.0). Where a Python reference needed more room, the problem raises its own multiplier in `problem.yaml`, up to the 10 s cap on effective limits.

Problems that needed changes:
- **Limits raised.** A few base limits went up while authoring (queue-swaps, rail-fares, critical-roads, fence-posts, signal-hub, festival-guards, ancestor-lookup, trail-markers, summit-pass), so the Python reference stays under 50 %. In each case the slow solution still TLEs at the new limit.
- **trail-markers** was cut to n, q <= 100 000. At 200 000 its Python reference used about 220 MB of the 256 MB limit.
- **ancestor-lookup and trail-markers** got offline Python references: one walk with the root path, and Tarjan's LCA. These are also independent of the C++ binary lifting, which strengthens the cross-check.
- **summit-pass** sorts packed integer edges in Python (Kruskal) instead of tuples.

**Packed size of codejudge-problems:**

| Point | Packed size |
|---|---|
| Before 5.6 | 244.06 MiB |
| After T | 272.46 MiB |
| After P | 382.59 MiB (including the regenerated leaderboard tests) |

The CI warning threshold is 500 MiB.

