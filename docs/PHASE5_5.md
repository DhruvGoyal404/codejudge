# Phase 5.5 — languages, problems, UI

Three pieces, in order: **L** (Java and JavaScript), **P** (the problem set), **U** (the UI overhaul). This file covers each as it lands.

## L. Java 21 and JavaScript (Node 22)

### Images

| Language | Compile image | Run image | Base (pinned by digest in the Dockerfile) |
|---|---|---|---|
| `java` | `java-compile` (JDK) | `java-run` (JRE only: no `javac`) | `eclipse-temurin:21.0.12_8-jdk-noble` / `21.0.12_8-jre-noble` |
| `javascript` | `node` | `node` | `node:22.23.3-bookworm-slim` |

Every image uses the same `judge-exec` builder stage, `USER 65534` and `ENTRYPOINT /judge-exec` as the C++/Python images. `scripts/build-images.ps1` builds all six and writes `images.lock.json`. The run images carry no compiler: the JRE has no `javac`. Node needs no compile image, since `node --check` *is* the run-time binary.

### Compile and run

- **Java.** The source must be `Main.java` with a `public class Main`. Compile runs `javac -encoding UTF-8 -d out Main.java` with the compiler's own heap capped (`-J-Xmx512m`, serial GC). It fails with a compile error if `out/Main.class` is missing, which catches a wrongly named class. It then packs `out/` into `main.jar`, the only artifact. A CE carries javac's diagnostics.
- **Run (Java).** `java -Xmx{mem}m -Xss{stack}k -XX:+UseSerialGC -XX:ActiveProcessorCount=1 -XX:CICompilerCount=2 -XX:-UsePerfData -XX:+ExitOnOutOfMemoryError -Xshare:auto -cp /box/main.jar Main`.
- **JavaScript.** "Compile" is `node --check main.js`, a syntax check only, and a CE shows node's message.
- **Run (JavaScript).** `node --max-old-space-size={mem} --stack-size={stack} --v8-pool-size=1 /box/main.js`. Programs read stdin with `require("fs").readFileSync(0, "utf8")`.
- Binaries use absolute paths (`/opt/java/openjdk/bin/...`), because judge-exec's `PATH` is only `/usr/local/bin:/usr/bin:/bin`.

### Sandbox tuning per language (`runner/internal/lang/lang.go`)

| | Heap flag | Stack flag | `MemOverheadMB` | `ExtraTasks` | OOM markers → MLE |
|---|---|---|---|---|---|
| cpp | — | — | 0 | 0 | — |
| python | — | — | 0 | 0 | `MemoryError` |
| java | `-Xmx` = problem limit | `-Xss` | 128 | 24 | `java.lang.OutOfMemoryError` |
| javascript | `--max-old-space-size` = problem limit | `--stack-size` | 64 | 16 | `JavaScript heap out of memory` |

- **Memory.**
  - The heap flag is the problem's memory limit, so a program gets as much heap as a C++ program gets address space.
  - The container cgroup and judge-exec's `--mem-kb` get the limit **plus** `MemOverheadMB`, which covers the runtime's own metaspace, code cache, thread stacks and so on.
  - The MLE ceiling on peak RSS includes the same overhead.
  - Measured idle RSS: about 36 MB for the JVM and about 44 MB for Node, both well inside their overheads.
- **Stack.**
  - `{stackKB}` = min(¾ × memory limit, 64 MB), always below RLIMIT_STACK.
  - `TestDeepRecursion` runs 200 000-deep recursion in both languages.
- **Processes.** `ExtraTasks` is added both to RLIMIT_NPROC and to the pids cgroup, for compile and for run.
  - The JVM starts 13 threads (serial GC, 1 CPU, 2 JIT threads); Node starts 4.
  - `TestRuntimeThreadsFit` requires the start-up thread count to be at most half the budget. Under runc the budgets are 48+24 for the JVM and 48+16 for Node; under runsc they are 32+ExtraTasks.
- **OOM → MLE.**
  - A runtime that runs out of heap exits with an error (an RE), not a kill.
  - When a run would be RE and its stderr **or stdout** contains the language's OOM marker, the verdict is MLE ("runtime out of memory"). Stdout counts because the JVM prints its `ExitOnOutOfMemoryError` message there.
- **Output limit.**
  - The JVM ignores SIGXFSZ, and Node buffers its writes, so on overflow they would end as TLE or MLE respectively.
  - judge-exec now polls the size of the stdout file and kills the process group when the file reaches the cap. All four languages report OLE.

### Time multipliers

`problem.DefaultMultipliers`: cpp 1.0, python 2.0, java **2.0**, javascript **2.0**. The effective limit is the problem's `time_limit_ms` × the multiplier. A problem may override this in `problem.yaml`.

The calibration criterion is the one Python already had: **on every seed problem, the reference in each language uses at most 50 % of its effective limit on every test**. `TestProblems` asserts this for `ref.py`, `ref.java` and `ref.js`. The table shows the measurements: max CPU over all tests, local runc, Docker Desktop/WSL2, 2026-10-15.

| Problem (limit) | ref.cpp | ref.py | ref.java | ref.js |
|---|---|---|---|---|
| ledger-total (1000 ms) | 34 | 49 | 112 | 100 |
| range-ledger (1000 ms) | 34 | 257 | 197 | 192 |
| courier-grid (1000 ms) | 10 | 430 | 168 | 99 |
| rising-towers (1000 ms) | 27 | 115 | 104 | 114 |
| farthest-beacons (2000 ms) | 40 | 676 | 362 | 497 |

Linux CI (GitHub `ubuntu-latest`, run 38630724103, commit 238b7e8), max CPU in ms as runc / runsc. gVisor reports CPU in 10 ms steps.

| Problem | ref.py | ref.java | ref.js |
|---|---|---|---|
| ledger-total | 35 / 50 | 67 / 130 | 67 / 100 |
| range-ledger | 158 / 210 | 171 / 280 | 127 / 190 |
| courier-grid | 256 / 170 | 123 / 170 | 55 / 90 |
| rising-towers | 68 / 70 | 83 / 150 | 66 / 90 |
| farthest-beacons | 480 / 410 | 315 / 280 | 318 / 350 |

The worst non-C++ reference uses 13 % of its effective limit on runc (courier-grid Python, 256 of 2000 ms) and 14 % on runsc (range-ledger Java, 280 of 2000 ms).

What the numbers mean:
- **Java and JavaScript use at most 12.5 % of their 2× limit.** On these inputs their cost is mostly start-up, about 60–110 ms (JVM boot and JIT warm-up; Node boot plus parsing all of stdin as a string). The worst cases are farthest-beacons: sorting 2·10⁵ points, then BigInt cross products in JS.
- **Why 2.0 rather than less.** A 1.5× multiplier would also pass today. 2.0 is kept for two reasons:
  - The heavier P-batch problems will spend proportionally more time in un-JITted code.
  - Python, at 2.0, is still the binding constraint: its 676 ms is the closest any reference comes to the 50 % line.
- **CI re-measures this on Linux on every push and nightly.** It runs under runc and runsc, in the "Seed problems, all reference languages" step. The step summary lists each reference's `max_cpu` against its limit. If a P-batch problem pushes a Java/JS reference past 50 %, the assertion fails, and the multiplier (or that problem's override) gets revisited with the data.

Compile time is not part of the time limit. On the dev machine, javac takes about 2.5–3.2 s and `node --check` about 0.4–0.6 s.

### Starter templates (`web/src/lib/templates.ts`)

Each language opens with a template that reads all of stdin quickly and writes the output once:
- C++ uses `sync_with_stdio(false)`.
- Python uses `sys.stdin.read().split()`.
- Java uses a byte-buffered `FastReader` over `DataInputStream` and one `PrintWriter` flushed at the end. `Scanner` is far too slow for 10⁵-token inputs.
- JavaScript uses `readFileSync(0)` split into tokens, with output joined once.

### Test matrix (all four languages, runc and runsc in CI)

- **Per-test container (`integration_test.go`).**
  - OK.
  - CE, including `nomain.java`.
  - RE (an exception with its message in stderr).
  - TLE, both a CPU busy loop and a sleeper hitting the wall limit (C++/Java/JS).
  - MLE, which includes runtime OOM → MLE.
  - OLE (C++/Java/JS).
  - Threads (C++/Python/Java).
  - Deep recursion (Java/JS) and runtime threads fitting their budget (Java/JS).
- **Batch mode (`batch_integration_test.go`).**
  - OK.
  - No inherited descriptors. The JVM's and Node's own files and anon inodes are allowed; anything else, sockets included, fails the test.
  - A stdin over-read never sees the next test.
  - Other tests' inputs stay invisible (snoop, in Python/Java/JS).
  - Verdict forgery through judge-exec's channel is denied. The JVM exits slowly enough that a forked child may run, but its attempt on `/proc/1/fd/1` must also be denied, and the verdict stays the program's own RE.
- **Seed problems (`problems_integration_test.go`).** ref.cpp, ref.py, ref.java and ref.js must get AC, with the 50 % margin for non-C++. wrong.cpp must get WA and slow.cpp TLE. The Java/JS references live in the private problems repo next to the others.

Database: migration `20261015000001_more_languages.sql` widens `submissions_language_check` to all four languages. The API's `LANGUAGES` and the web `Language` type follow it.

### Host guards cover transfer time (found while authoring P)

The large P tests exposed an intermittent IE. A 3.7 MB input whose result frame is about 5 MB (10^5 lines of 36-digit numbers) took 3.6 s per test end to end on Docker Desktop, with 210 ms of program wall time. Moving the bytes through the container attach pipe ran at about 2.6 MB/s idle, and slower under load. The per-test host guard was a constant, wall limit + 5 s, so under load it fired: "send test 6: i/o timeout" and "no result within host guard".

- **Per-test guard:** wall + 5 s + the time to move this test's input and the largest possible result frame at 1 MiB/s (`transferRate`).
- **Batch deadline:** includes the same allowance for all inputs and frames. A batch's inputs are capped at 64 MiB (`maxBatchInputBytes`; problems are capped at 32 MB), and `Limits.OutputBytes` at 16 MiB (`MaxOutputBytes`).
- **The bounds that depend on it:**
  - The longest judging submission is 29m43s, so the worker's `TimeoutStopSec` goes from 30 to 45 min.
  - The longest any container can live (with the 16 MiB tool cap) is 41m28s, so `ReaperThreshold` goes from 30 to 60 min.
  - The API's `SWEEP_RUNNING_AFTER_MS` default follows the reaper threshold to 60 min, so a legitimately slow submission is never judged twice.
- **Effect on healthy runs:** none. The guard only decides how long the host waits before declaring a container dead.

## P. The problem set

### P0. Schema, authoring pipeline, the five seed problems upgraded

**`problem.yaml` gains two required fields.** The loader rejects a package without them.

```yaml
difficulty: medium            # easy | medium | hard
tags: [graphs, bfs, matrix]   # 1..5 tags from the controlled vocabulary problem.Tags
```

The vocabulary is fixed in `runner/internal/problem/problem.go` so that a typo can't create a new filter value in the UI. Both fields are imported into `problems.difficulty` and `problems.tags` (migration `20261015000002`), and both are served by `GET /problems` and `GET /problems/:slug`.

**Catalog rules.** `judge-admin check` enforces these on top of what `Load` validates; CI runs it in the "Problems" job:
- At least 25 tests (`CatalogMinTests`; 45 since Phase 5.6) and at most 50 (`MaxTests`).
- Total test size of at most 32 MB per problem (`MaxTotalBytes`, enforced by `Load`).
- With the private repo present, every problem must have `gen/gen.py`, `gen/validate.py`, `solutions/ref.cpp` and `solutions/ref.py`.
- A medium or hard problem must also have a `solutions/slow.*`, which must TLE.

**Private repo layout per problem.**
- `gen/gen.py DIR` is seeded and writes `DIR/NN.in`.
- `gen/validate.py` checks one input from stdin. It uses `lib/cjval.py`, a strict reader that enforces single spaces, exact newlines, no trailing data and bounded integers.
- `solutions/`: `ref.cpp` and `ref.py` (both required), `ref.java` and `ref.js` (optional), and `wrong*` / `slow*` (fixtures).
- `tests/`: the generated tests.

`lib/cjgen.py` gives generators a common output-directory convention.

**`scripts/make-tests.py`** builds the tests for each problem:
1. Generate the inputs.
2. Validate every input.
3. Run `ref.py` and `ref.cpp` on every input in the real sandbox, using `judge-run outputs` (compile once, one batch container, the exact stdout of each run). The two outputs must be byte-identical.
4. Write them as `NN.out`, after checking the test count and total size.

`--check` does the same in a temporary directory and requires the committed `tests/` to be exactly what it produces. CI runs that under runc on every push, so a generator, validator or reference that drifts fails the build.

**`TestProblems`** (`runner/internal/judge`) judges every package with every solution it finds:
- `ref.*` must get AC, and a non-C++ reference must stay within 50 % of its effective limit.
- `wrong*` must get WA and `slow*` must get TLE.
- On push CI judges with C++ only (`JUDGE_PROBLEM_LANGS=cpp`); nightly and manual runs use all four languages, under runc and runsc.

**The five seed problems** now have 28 tests each. Tests 01–10/11 (and so the public samples) are byte-for-byte unchanged; the new tests add boundary and stress cases. Each problem also got a validator and its difficulty and tags.

| Problem | Difficulty | Tags | Tests | Size |
|---|---|---|---|---|
| ledger-total | easy | math, implementation | 28 | 10.5 MB |
| range-ledger | easy | arrays, prefix-sums | 28 | 25.6 MB |
| courier-grid | medium | graphs, bfs, matrix | 28 | 2.7 MB |
| rising-towers | medium | dynamic-programming, binary-search | 28 | 9.4 MB |
| farthest-beacons | hard | geometry, two-pointers, sorting | 28 | 11.1 MB |

### P1–P6. The catalog

60 problems: the 5 upgraded seeds and 55 new ones in six batches: 22 easy, 27 medium and 11 hard. Every one has at least 25 tests, a strict validator, C++ and Python references with byte-identical outputs (`make-tests.py`), and AC for both references, with Python within 50 % of its limit (`TestProblems`). Every medium and hard problem also has a `slow.*` that gets TLE. Statements, titles and examples are original.

While authoring, a few base limits went up or got a Python multiplier so the Python reference stays under 50 %; the table lists them. Two infrastructure bugs surfaced and were fixed along the way: the UID race (`5a7dbb0`) and transfer-time guards (`eb0b7ea`). One planned hard problem, a lazy range-add/range-max structure, was replaced by bamboo-growth (a linear recurrence via matrix powers): no Python solution fit within the limit while an O(nq) C++ solution still had to TLE.

| Difficulty | Slug | Title | Tags | Limit | Python × |
|---|---|---|---|---|---|
| easy | `anagram-groups` | Anagram Groups | strings, hashing, sorting | 1s | 2 |
| easy | `badge-codes` | Badge Codes | strings, hashing | 1s | 2 |
| easy | `bracket-ledger` | Bracket Ledger | stack, strings | 1s | 2 |
| easy | `caravan-split` | Caravan Split | prefix-sums, arrays | 1s | 2 |
| easy | `cipher-wheel` | Cipher Wheel | strings, math | 1s | 2 |
| easy | `clock-drift` | Clock Drift | math, implementation | 1s | 2 |
| easy | `digit-roots` | Digit Roots | math, strings | 1s | 2 |
| easy | `echo-log` | Echo Log | hashing, arrays | 1s | 2 |
| easy | `elevator-log` | Elevator Log | implementation, arrays | 1s | 2 |
| easy | `grade-curve` | Grade Curve | sorting, binary-search | 2s | 2 |
| easy | `ledger-total` | Ledger Total | math, implementation | 1s | 2 |
| easy | `map-rotation` | Map Rotation | matrix, implementation | 1s | 2 |
| easy | `mirror-tags` | Mirror Tags | strings, two-pointers | 1s | 2 |
| easy | `pair-sums` | Pair Sums | hashing, arrays | 1s | 2 |
| easy | `prime-lamps` | Prime Lamps | number-theory, math | 1s | 2 |
| easy | `rainfall-median` | Rainfall Median | sorting | 1s | 2 |
| easy | `range-ledger` | Range Ledger | arrays, prefix-sums | 1s | 2 |
| easy | `shared-members` | Shared Members | two-pointers, sorting | 1s | 2 |
| easy | `stair-hops` | Stair Hops | dynamic-programming | 1s | 2 |
| easy | `tide-gauge` | Tide Gauge | arrays, implementation | 1s | 2 |
| easy | `tile-floors` | Tile Floors | number-theory, math | 1s | 2 |
| easy | `vending-change` | Vending Change | greedy, math | 1s | 2 |
| medium | `cargo-hold` | Cargo Hold | dynamic-programming | 1s | 2 |
| medium | `courier-grid` | Courier Grid | graphs, bfs, matrix | 1s | 2 |
| medium | `course-order` | Course Order | topological-sort, heap, graphs | 2s | 2 |
| medium | `fare-combinations` | Fare Combinations | dynamic-programming, combinatorics | 2s | 2 |
| medium | `frost-spread` | Frost Spread | bfs, matrix, graphs | 2s | 2 |
| medium | `fuel-window` | Fuel Window | two-pointers, sliding-window | 1s | 2 |
| medium | `gap-ranking` | Gap Ranking | binary-search, two-pointers, sorting | 2s | 2 |
| medium | `guild-alliances` | Guild Alliances | union-find | 1s | 2 |
| medium | `hall-bookings` | Hall Bookings | intervals, sorting | 2s | 2 |
| medium | `lantern-festival` | Lantern Festival | prefix-sums, arrays | 1s | 2 |
| medium | `market-stalls` | Market Stalls | intervals, sorting | 1s | 2 |
| medium | `network-backbone` | Network Backbone | graphs, union-find, greedy | 2s | 4 |
| medium | `orchard-path` | Orchard Path | dynamic-programming, matrix | 2s | 2 |
| medium | `press-split` | Press Split | binary-search, greedy | 2s | 2 |
| medium | `reef-islands` | Reef Islands | bfs, matrix, graphs | 2s | 2 |
| medium | `relay-delays` | Relay Delays | shortest-paths, graphs, heap | 3s | 2 |
| medium | `rising-towers` | Rising Towers | dynamic-programming, binary-search | 1s | 2 |
| medium | `rival-teams` | Rival Teams | graphs, bfs | 2s | 2 |
| medium | `river-stones` | River Stones | greedy, bfs | 1s | 2 |
| medium | `running-median` | Running Median | heap | 2s | 2 |
| medium | `shared-melody` | Shared Melody | dynamic-programming, strings | 1s | 2 |
| medium | `skyline-watch` | Skyline Watch | stack, arrays | 1s | 2 |
| medium | `sprinkler-cover` | Sprinkler Cover | greedy, intervals, sorting | 2s | 2 |
| medium | `tally-windows` | Tally Windows | prefix-sums, hashing | 1s | 2 |
| medium | `trail-length` | Trail Length | trees, dfs | 2s | 4 |
| medium | `typo-distance` | Typo Distance | dynamic-programming, strings | 2s | 2 |
| medium | `window-peaks` | Window Peaks | queue, sliding-window | 1s | 2 |
| hard | `bamboo-growth` | Bamboo Growth | math, dynamic-programming, matrix | 1s | 2 |
| hard | `canal-routes` | Canal Routes | trees, dfs | 2s | 4 |
| hard | `echo-phrase` | Echo Phrase | strings, hashing, binary-search | 2s | 4 |
| hard | `farthest-beacons` | Farthest Beacons | geometry, two-pointers, sorting | 2s | 2 |
| hard | `island-courier` | Island Courier | dynamic-programming, bit-manipulation | 2s | 2 |
| hard | `one-way-districts` | One-Way Districts | graphs, dfs | 2s | 4 |
| hard | `exhibit-variety` | Exhibit Variety | segment-tree, sorting | 2s | 4 |
| hard | `signal-towers` | Signal Towers | segment-tree | 2s | 3 |
| hard | `stone-duel` | Stone Duel | games, dynamic-programming | 1s | 4 |
| hard | `survey-plot` | Survey Plot | geometry, number-theory | 1s | 2 |
| hard | `team-draft` | Team Draft | dynamic-programming, bit-manipulation | 1s | 4 |

## U. UI

### U2. Run with custom input, result panel

- **Run** executes the current code once on an input the user types, or on a sample loaded with one click, under the problem's time and memory limits, and shows the program's own output. Nothing is judged, and nothing touches hidden tests or Postgres.
- **API:** `POST /runs {problemSlug, language, source, input}` returns `202 {id}`, then `GET /runs/:id` returns `{status, result}`. Only the owner can read a run; anyone else gets 404.
  - **Limits:** input of at most 64 KB; its own rate limit (`RUN_LIMIT_PER_MIN` 10, `RUN_LIMIT_PER_DAY` 300, separate from submissions); one run in progress per user (409).
  - **Storage:** the job and result live in a Valkey hash (`RUN_KEY_PREFIX` + id) for `RUN_TTL_S` (1 h).
- **Worker** (`internal/worker/runs.go`): it reads `RUNS_STREAM` through its own consumer group with `RunConcurrency` (1) slots. The sandbox's concurrency grows by the same amount.
  - Runs are **at-most-once**: an entry is acked on read, and a run lost to a crash ends as a timeout in the browser after 90 s. Retrying a scratch run isn't worth the complexity of the submission path's reclaim and fencing.
  - Stdout is capped at 64 KB (more is OLE). An IE submission verdict now logs its reason.
- **Browser:**
  - **Run button and shortcuts:** a Run button next to Submit, with `Ctrl+'` (also inside Monaco).
  - **Tabs:** the bottom pane has a **Run** tab and a **Submission** tab (WAI-ARIA tabs, arrow keys).
  - **Input:** the input is remembered per problem.
  - **Output:** status, CPU and memory, stdout, stderr, compiler output. When the input is a sample, it says "matches sample NN" or shows a diff against the expected output.
  - **Layout:** input and output sit side by side when the pane is wide enough (a container query, so it follows the splitter).
  - **Submission result:** a summary line ("28/28 tests passed · max CPU · max memory"), and the current stage marked with `aria-current="step"`.
- **Tests:** API (`test/runs.test.ts`: auth, validation, sizes, one active run, owner-only reads, separate 429); API end-to-end with a real worker (OK, CE with compiler output, TLE, OLE, no submission rows); Playwright (`e2e/ui.spec.ts`: matching sample, custom input, diff, submit, tab keyboard, axe in both themes).

Statements no longer carry an `## Example` section: the samples shown under the statement are the single source (`samples/`).

### U3. Landing page, mobile read-only view, polish

- **Landing page (`/`):** what the judge is, live catalogue counts by difficulty, three feature cards, and one problem per difficulty to start with (the first one you haven't solved). For a logged-out visitor it adds a GitHub login button; for a logged-in user, their progress. The problem list moved to `/problems`, linked from the header (`aria-current="page"` when active).
- **Phones (< 768 px):** the problem page is read-only: a short note, then the statement and samples. Monaco isn't even loaded. Tablets keep the stacked editor. The list hides the tag and limit columns. The header keeps the login name and theme label for screen readers only. No page scrolls horizontally at 390 px (tested).
- **Polish:**
  - Every page uses the design tokens: one palette, AA contrast in both themes.
  - Verdict and status badges share the difficulty colours.
  - Links inside running text are underlined (axe `link-in-text-block`).
  - Each page sets its browser tab title ("Courier Grid · CodeJudge").
  - There's a real 404 page.
- **Accessibility:** axe (WCAG 2.1 A/AA, Monaco excluded) passes on every page in both themes: landing (logged in and out), list, problem page, Run and Submission tabs, submission detail, profile, 404, and the three phone views.
- **Bundle:** the main chunk is 469.7 kB, +5.4 % against the pre-U baseline of 445.5 kB. CI fails above +20 %, or if Monaco ever lands in the main chunk.

### CI: end-to-end job and failure evidence

The browser and API end-to-end suites now run in CI (job "End-to-end"; push, PRs from this repo, nightly). On failure:
- the worker log and API log (`$E2E_EVIDENCE_DIR`) and Playwright's traces are uploaded as the `e2e-evidence` artifact;
- the database rows of the failed run are kept, not deleted, and dumped with the Valkey run hashes to `records.json` (`api/test/e2e-evidence.ts`).

On its first CI run this caught a real configuration gap (the GitHub login redirect needs an OAuth client id, now a dummy one in CI) and uploaded the evidence as designed.

### P7. Gap-filling batch

Four problems cover techniques the catalogue lacked. `trie` joins the tag vocabulary.

| Difficulty | Slug | Title | Tags | Limit | Python × |
|---|---|---|---|---|---|
| easy | `tree-walks` | Tree Walks | trees, recursion | 2s | 2 |
| medium | `motif-search` | Motif Search | strings | 1s | 2 |
| medium | `signal-interference` | Signal Interference | trie, bit-manipulation | 1s | 5 |
| hard | `queen-garden` | Queen Garden | backtracking, bit-manipulation | 2s | 3 |

The catalogue is now 64 problems (23 easy, 29 medium, 12 hard).

**New loader rule:** an expected output may not exceed the judge's stdout cap (4 MB, `sandbox.DefaultOutputBytes`). Otherwise every correct solution would get OLE on that test. Tree Walks' first draft (three walks of 200 000 large labels, about 6.6 MB) broke this, and only `TestProblems` caught it. `judge-admin check` now rejects such a package outright. `judge-run outputs` keeps the 16 MiB cap, so an over-long reference output is still produced and then reported by the check.
