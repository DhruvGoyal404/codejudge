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

## P. The problem set

### P0. Schema, authoring pipeline, the five seed problems upgraded

**`problem.yaml` gains two required fields.** The loader rejects a package without them.

```yaml
difficulty: medium            # easy | medium | hard
tags: [graphs, bfs, matrix]   # 1..5 tags from the controlled vocabulary problem.Tags
```

The vocabulary is fixed in `runner/internal/problem/problem.go` so that a typo can't create a new filter value in the UI. Both fields are imported into `problems.difficulty` and `problems.tags` (migration `20261015000002`), and both are served by `GET /problems` and `GET /problems/:slug`.

**Catalog rules.** `judge-admin check` enforces these on top of what `Load` validates; CI runs it in the "Problems" job:
- At least 25 tests (`CatalogMinTests`) and at most 50 (`MaxTests`).
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
