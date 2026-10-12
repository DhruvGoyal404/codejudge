# Phase 1 — Go sandbox runner

Status: **complete**. All 18 integration checks pass, and the suite leaves 0 `judge.managed` containers behind. Docker API negotiated to **1.46** against engine 27.0.3, using `github.com/moby/moby/client` v0.6.2 + `github.com/moby/moby/api` v1.56.1.

## Layout

```
runner/                         Go module (go 1.24, toolchain go1.27.2)
  cmd/judge-exec/               PID 1 inside every container (linux; stub on other OSes)
  cmd/judge-run/                CLI: compile + run one program, print result JSON
  internal/protocol/            wire format shared by host and judge-exec
  internal/boxtar/              hardened tar build/extract/read (unit-tested)
  internal/lang/                language table (images, compile/run commands)
  internal/sandbox/             Docker plumbing, limits, status logic, integration tests
sandbox/images/*.Dockerfile     cpp-compile, cpp-run, python
sandbox/seccomp/default.json    moby v27.0.3 default profile (Phase 0)
scripts/build-images.ps1        builds images, writes sandbox/images/images.lock.json
```

## Toolchain and SDK

- `github.com/moby/moby/client` needs Go ≥ 1.24. `runner/go.mod` declares `go 1.24` and `toolchain go1.27.2`, which `GOTOOLCHAIN=auto` downloads into the module cache. The system Go (1.22.5) is untouched. CI must use `go-version-file: runner/go.mod`.
- The client is created with `client.New(client.FromEnv, client.WithAPIVersionNegotiation())` over the default `npipe:////./pipe/docker_engine`. Verified results: ping API 1.46, server 27.0.3 (min API 1.24), client range 1.40–1.56, negotiated 1.46. No fallback was needed.
- `judge-exec` is built inside `golang:1.27.2@sha256:5bc7f572…`, so the image binary and local builds share one toolchain. It's built with `CGO_ENABLED=0 GOTOOLCHAIN=local -trimpath -ldflags="-s -w"`: a static binary of about 4.5 MB.

## Images

| Image | Base (pinned by digest) | Contents | Size |
|---|---|---|---|
| `cpp-compile` | `gcc:14.2.0@sha256:b99b86a2…` | g++ + judge-exec | 1.43 GB |
| `cpp-run` | `scratch` | judge-exec **only** (no compiler, shell or libc); the static program arrives in the tar | 2.98 MB |
| `python` | `python:3.12.7-slim-bookworm@sha256:60d9996b…` | CPython + judge-exec. Used for both the `py_compile` check and the run | 127 MB |

The locally built images have no registry digest, so the runner pins them by **image ID**. `build-images.ps1` records `sha256:…` IDs in `images.lock.json`, and containers are created from those IDs, never from tags. The lock file is machine-local and gitignored. All images carry `LABEL judge.managed=true`, run as `USER 65534:65534`, and use `ENTRYPOINT ["/judge-exec"]`.

## Execution design

```
judge-run ─► Sandbox.Compile ─► container(cpp-compile | python) ─► tar{result.json, main}
          └► Sandbox.Run     ─► container(cpp-run | python)     ─► JSON frame ─► classify ─► Result
```

**Host side (`internal/sandbox/sandbox.go`), for every container:**
1. Acquire the concurrency semaphore (default 2).
2. Create the container with:
   - `--network none` (plus `NetworkDisabled`);
   - `Memory == MemorySwap`, `NanoCPUs = 1e9`, `PidsLimit = 64`;
   - `ReadonlyRootfs`, `CapDrop ALL`;
   - `SecurityOpt = [no-new-privileges, seccomp=<inlined compact JSON of sandbox/seccomp/default.json>]`;
   - `LogConfig none`, `User 65534:65534`, `ulimit nofile 256`;
   - tmpfs `/box` (`rw,exec,nosuid,nodev`, sized per run) and `/tmp` (`rw,noexec,nosuid,nodev`);
   - `OpenStdin + StdinOnce`, labels `judge.managed=true` and `judge.role=compile|run`, and a random `judge-<hex>` name.
3. `defer ContainerRemove(force)` **with a fresh background context**, so it runs on success, error, deadline and panic.
4. Attach (stdin, stdout, stderr) **before** start, so no output can be missed. Then start.
5. A goroutine writes the input tar to the hijacked connection, then calls `CloseWrite`, which gives the container stdin EOF.
6. `stdcopy.StdCopy` demultiplexes the stream into a **hard-capped** stdout buffer. If the cap is exceeded, the container is killed immediately. Container stderr is capped at 16 KB and the rest discarded.
7. An outer deadline (the judge-exec wall limit plus 20 s of grace) kills the container if judge-exec never answers.
8. `ContainerWait`, then `ContainerInspect`, to read `State.OOMKilled` and the exit code **before** the deferred removal.

**Startup reaper (`Sandbox.Reap`, called from `New`):** removes `judge.managed=true` containers that are not running, or that are running but older than 10 minutes. See deviation 4.

**`judge-exec` (PID 1, `cmd/judge-exec/main.go`):**
- **Input:** extracts the stdin tar into `/box` (`internal/boxtar`). It enforces a total-bytes limit and a file-count limit, and rejects absolute paths, `..`, backslashes, unclean names, symlinks, hardlinks, devices and FIFOs. It never overwrites existing files (`O_EXCL`).
- **Starting the program:** it re-executes itself as `__child`, which applies the rlimits (process-wide, so this is safe in Go) and then `execve`s the program. Go's `ForkExec` cannot set rlimits directly. The program runs in its own process group (`Setpgid`) with a fixed, minimal environment:
  - stdin from `/box/input` (run mode) or `/dev/null` (compile mode);
  - stdout and stderr redirected to files in `/box`.
- **rlimits:**
  - `RLIMIT_CPU`: soft = ceil(TL) + 1 s, hard = soft + 1 s (SIGXCPU, then SIGKILL).
  - `RLIMIT_FSIZE` = the output limit.
  - `RLIMIT_CORE` = 0.
  - `RLIMIT_STACK` = the memory limit.
- **Limits it enforces itself:**
  - **Wall clock:** SIGKILL to the process group at `WallLimit(TL) = 2·TL + 1 s`.
  - **Peak RSS:** polls `/proc/<pid>/status` VmHWM every 5 ms and sends SIGKILL to the group once it exceeds the memory limit.
- **Measurement:** `wait4` collects `cpu_ms = utime + stime` and `max_rss_kb = ru_maxrss`, the larger of that and the polled VmHWM.
- **Teardown:** `kill(-1, SIGKILL)` reaches every other process in the container (as PID 1 this covers the whole PID namespace). judge-exec then reaps everything with `wait4(-1)` until `ECHILD`, and **only then** writes its single result to stdout.
- **Output:**
  - Run mode writes one JSON frame: `{mode, status, exit_code, signal, cpu_ms, wall_ms, max_rss_kb, stdout, stderr, stdout_bytes, stdout_truncated, stderr_truncated, output_limit_hit, error}`.
  - Compile mode writes a tar containing `result.json` followed by the artifacts, or only `result.json` on failure, with compiler output capped at 64 KB.

**Status logic (`internal/sandbox/status.go`), with precedence IE > MLE > TLE > OLE > RE > OK:**
- **IE:** a Docker or transport failure, no frame, an unparseable frame, judge-exec reporting `status=error`, or the host stdout cap being hit.
- **MLE:** `OOMKilled`, judge-exec's RSS kill, or `max_rss_kb` > the limit.
- **TLE:** judge-exec's wall kill, `cpu_ms` > TL, or SIGXCPU.
- **OLE:** SIGXFSZ, stdout reaching `RLIMIT_FSIZE`, or truncated stdout.
- **RE:** any signal or a non-zero exit.
- **OK:** none of the above.
- **CE** comes from the compile step: a non-zero compiler exit, a compile timeout, or the compiler hitting its memory limit.

## Limits and memory accounting

| Parameter | Value |
|---|---|
| Wall limit | `2·TL + 1 s` (enforced in judge-exec) |
| Host outer deadline | wall + 20 s (container create/start on this host takes ~1–2 s, more under load) |
| Run container memory (`Memory = MemorySwap`) | **problem limit + 24 MB helper headroom + `/box` size + 16 MB `/tmp`** |
| `/box` size (run) | input tar MB + 2 × output-limit MB + 8 MB |
| Example: 256 MB limit, 4 MB output | C++: 256 + 24 + 18 + 16 = **314 MB**; Python: 256 + 24 + 16 + 16 = **312 MB** |
| Default output limit | 4 MB (`--output-limit`); stderr returned up to 64 KB |
| PIDs / CPUs / nofile | 64 / 1 / 256 |
| Compile container | 1024 MB, 1 CPU, 64 PIDs, CPU 15 s, wall 45 s, `/box` 128 MB, `/tmp` 64 MB; source ≤ 1 MB |

**Why the headroom:** tmpfs pages are charged to the container's memory cgroup. Without headroom, a program at exactly its limit, plus judge-exec, plus the files in `/box` and `/tmp`, would be OOM-killed by the kernel instead of being measured. With it, judge-exec's RSS poller stops the program at the *problem* limit. The cgroup OOM killer remains as a backstop and is reported via `OOMKilled`.

## Integration tests

Command: `go test -tags integration -count=1 -v ./internal/sandbox/`

Run 2026-10-12, 72.6 s total.

| Test | Fixture | Result | Key fields observed |
|---|---|---|---|
| OK cpp / python | `ok.cpp`, `ok.py` | OK ✅ | stdout `42`; cpu 8 / 63 ms; RSS 3.1 / 9.7 MB |
| CE cpp / python | `ce.cpp`, `ce.py` | CE ✅ | compiler diagnostics returned |
| RE segfault | `segv.cpp` | RE ✅ | signal 11 |
| RE nonzero exit | `exit3.cpp` | RE ✅ | exit 3, stdout preserved |
| RE python exception | `exc.py` | RE ✅ | exit 1, stderr contains `ValueError: boom` |
| TLE busy loop | `busy.cpp` (TL 2 s) | TLE ✅ | signal 24 (SIGXCPU) at cpu 3245 ms |
| TLE sleep forever | `sleep.cpp` | TLE ✅ | cpu 6 ms, wall 5002 ms (killed at the 5 s wall limit) |
| MLE cpp vector growth | `mle.cpp` (64 MB, TL 5 s) | MLE ✅ | killed at RSS 65,796 KB, cpu 270 ms, OOMKilled=false (RSS poller) |
| MLE python list growth | `mle.py` (64 MB, TL 5 s) | MLE ✅ | killed at RSS 66,208 KB |
| OLE | `ole.cpp` (1 MB output limit) | OLE ✅ | signal 25 (SIGXFSZ); returned stdout ≤ 1 MB |
| seccomp active | `keyctl.cpp` | OK ✅ | `keyctl errno=1 EPERM` |
| network blocked | `net.py` | OK ✅ | `blocked: 101 Network is unreachable`, DNS `gaierror` |
| process limit | `fork.cpp` (tries 200) | OK ✅ | `started=58 failed=142` (judge-exec + its Go threads use the rest of the 64 PIDs) |
| concurrency | 8 distinct Python programs in parallel | ✅ | every program got exactly its own 300 lines |
| post-suite invariant | — | ✅ | `0 judge.managed containers left` |

The CLI was also verified: `judge-run --lang cpp|python --src … --stdin … --time-limit 2s --memory-limit 256` prints OK with `"42\n"`.

## Benchmark: per-testcase overhead (create → result, host side)

20 sequential runs per language. The program is already compiled. Command: `go test -tags integration -run TestBenchOverhead -v ./internal/sandbox/`

| Language | Run payload in tar | p50 | p95 | min | max | Host free RAM |
|---|---|---|---|---|---|---|
| cpp (run 1) | 2,502,440 B (static binary) | 1.995 s | 5.997 s | 1.576 s | 9.843 s | ~0.9–1.3 GB |
| python (run 1) | 46 B | 0.997 s | 1.428 s | 0.797 s | 2.452 s | |
| cpp (run 2) | 2,502,440 B | 3.141 s | 3.720 s | 2.510 s | 3.881 s | 1.3 GB |
| python (run 2) | 46 B | 1.250 s | 1.593 s | 0.929 s | 9.407 s | |

**Where the time goes:**
- **Payload transfer through the Windows named pipe is slow.** A controlled check sent the same Python program with a 5 B vs a 2.4 MB stdin: 713–1149 ms vs 1420–2153 ms, about **+0.6–1.0 s per 2.4 MB (≈2.4–3.5 MB/s)**. This matches Phase 0's V6 throughput, and it is the main reason C++ (2.5 MB static binary per test case) is slower than Python.
- **Container lifecycle:** create + attach + start + wait + inspect + remove costs **~0.7–1 s** even for a 46-byte payload.
- **Variance** is high on this host. Docker Desktop shares 15.7 GB of RAM with the owner's other running containers, and only 0.9–1.3 GB was free during the runs.

**Implications for later phases (not done now):**
- Ship the C++ binary once per *submission*, not once per *test case*. That means a warm run container per submission that executes many test cases, or stripping the binary with `-s`.
- On the Linux EC2 worker (Phase 6), the unix socket removes the npipe bottleneck. Re-benchmark there before optimising.

## Finding: MLE vs TLE depends on host memory pressure (WSL2)

At the default 2 s / 256 MB limits, the first `mle.cpp` run was reported as **TLE**, not MLE. It had reached only 187 MB RSS after 3354 ms CPU (filling at ~57 MB/s). Three immediate reruns were all **MLE** at 1.0–1.6 s CPU, getting faster each time (138 → 181 → 216 MB/s). Host free RAM was 0.9 GB.

This matches the slow first-touch page faults seen in Phase 0 V2. The WSL2 VM's memory is backed by Windows on demand, so a first touch of never-used guest pages is expensive under host memory pressure. The page-fault time counts as `stime`, so the program legitimately consumes CPU before it reaches the memory limit.

Given the evidence (CPU over the limit while RSS is still under it), the classifier's TLE verdict is *correct*. The cause is the environment, not the code. I didn't add a heuristic (for example "TLE with RSS near the limit → MLE"), because that would weaken the specified precedence. The integration MLE tests use 64 MB / 5 s so they are deterministic on this host. Expect this effect to disappear on a dedicated Linux host; re-check in Phase 6.

## Deviations from the spec, and why

1. **Frame stdout/stderr are base64.** They're `[]byte` fields, which `encoding/json` encodes as base64, so non-UTF-8 program output survives intact. The CLI prints them decoded as strings. Both are still capped (stdout at the output limit, stderr at 64 KB).
2. **No frame + `OOMKilled` → MLE, not IE.** If the cgroup OOM kill takes judge-exec down with the program, the cause is the submission's memory use. Every other "no frame" case is IE.
3. **MLE is also enforced live.** judge-exec polls VmHWM every 5 ms and kills at the problem limit. The spec mentioned `max_rss` over the limit; the poller is what makes "over the problem limit" detectable before the larger container limit is reached. Both integration MLE cases were caught this way (OOMKilled=false).
4. **The reaper doesn't remove fresh running containers.** It removes `judge.managed` containers that are not running, or running ones older than 10 minutes. Removing every managed container at startup would let two concurrent `judge-run` processes destroy each other's runs.
5. **The Python image is shared by compile and run.** "Compiler never present in run images" holds for C++ (the run image is `scratch` plus judge-exec). For Python, `py_compile` is part of the interpreter, so the run image necessarily contains it.
6. **Built images are pinned by local image ID** through the lock file. Base images are pinned by registry digest. The built images aren't pushed anywhere yet, so they have no registry digest.
7. **Additions beyond the spec:**
   - an exec-allowed `/box` tmpfs (needed because `/tmp` is `noexec`; see Phase 0);
   - `ulimit nofile=256`;
   - `RLIMIT_CPU` hard = soft + 1 s;
   - a fixed child environment;
   - `.gitattributes` forcing LF for Go, Dockerfile and JSON files;
   - the wall-limit formula `2·TL + 1 s` (the spec left it open).
8. **`judge-run` exit code:** 0 whenever a result was produced, including CE/RE/TLE/…; 1 only for runner errors.

## Known limitations / follow-ups

- CPU time and RSS are measured for the main process only. Forked children's usage isn't attributed (they are bounded by the PID limit and the cgroup, and are killed at teardown).
- The PID budget is shared with judge-exec's Go runtime threads, leaving about 58 usable processes.
- The seccomp profile is moby's default. A judge-specific tighter profile (denying e.g. `ptrace`, `process_vm_*`, `io_uring_*`) is a Phase 6 hardening item.
- Payload transfer cost (above) for multi-test-case judging is a Phase 2/3 design point.
- Process slip during benchmarking: one ad-hoc `docker run --rm <cpp-compile image> true` was started without the `judge.managed` label. It exited and was removed immediately (`--rm`); nothing was left behind. No other non-labelled containers were created.
