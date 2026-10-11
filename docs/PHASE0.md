# Phase 0 — Sandbox validation on Docker Desktop (WSL2 + runc)

Run date: 2026-10-12 · Host: Windows 11 25H2 (26200.9457), i5-1235U (12 logical), 15.7 GB RAM.

**Summary.** The base flags enforce the network, PID, read-only and noexec limits correctly.

Things the runner (Phase 1) must handle:
1. **Seccomp must be passed explicitly.** The daemon is configured `unconfined`, and the filter containers inherit by default is permissive.
2. **Killing the `docker` client does not stop the container.** The runner must `docker kill`/`rm -f` by name.
3. **The memory limit is enforced, but filling it is slow on this host.** A 512 MB allocation was OOM-killed only after about 18 s, which is past a 15 s wall-clock timeout.
4. **`docker cp` is impossible with `--read-only`.** Code must be delivered via stdin (a tar stream) instead.
5. **`/tmp` is `noexec`**, so compiled binaries need a separate exec-allowed tmpfs.
6. **stdout through the Windows CLI is slow** (≈2–3.5 MB/s), and the `json-file` log driver stores all of it.

## Environment

| Item | Value |
|---|---|
| Docker Desktop | 4.32.0 (157355). Engine 27.0.3 (API 1.46), containerd 1.7.18, runc 1.1.13, docker-init 0.19.0 |
| OS / kernel | "Docker Desktop (containerized)", kernel `6.18.40.1-microsoft-standard-WSL2`, x86_64 |
| Cgroups | driver `cgroupfs`, **version 2** |
| Runtimes | `runc` (default), `io.containerd.runc.v2`. No gVisor/runsc |
| Storage driver | overlay2 |
| Resources visible to Docker | NCPU=12, MemTotal=8,165,765,120 B (≈7.6 GiB, the WSL default of about 50% of RAM; there is no `.wslconfig`) |
| Daemon security options | `seccomp` **profile=unconfined**, `cgroupns`. `docker info` warns: *"daemon is not using the default seccomp profile"* |
| Go / Node | go1.22.5 windows/amd64 / v22.19.0 |

Images (exact-version tags; recorded digests):

| Tag | RepoDigest |
|---|---|
| `debian:bookworm-slim` | `sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587` |
| `gcc:14.2.0` | `sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c` |
| `python:3.12.7-slim-bookworm` | `sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d` |

`debian:bookworm-slim` is a floating tag. Phase 1 should reference images **by digest**.

## Base flags under test
```
--network none --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --read-only
--tmpfs /tmp:rw,noexec,size=16m --cap-drop ALL --security-opt no-new-privileges
--user 65534:65534 --security-opt seccomp=sandbox/seccomp/default.json
```

**Harness:** each check ran `docker create`, then `docker start -a` through PowerShell `Start-Process`. The harness polled every 200 ms with a 15 s host-side timeout, killed the client on timeout, recorded `docker inspect`, then ran `docker rm -f` and confirmed the container was gone. All containers were named `judge-p0-*`.

## Seccomp

`sandbox/seccomp/default.json` is moby's `profiles/seccomp/default.json` at tag **v27.0.3**:
- Fetched from `raw.githubusercontent.com/moby/moby/v27.0.3/...`.
- 12,828 bytes, sha256 `9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76`.
- `defaultAction: SCMP_ACT_ERRNO`, 31 rules.

The CLI inlines the profile into `HostConfig.SecurityOpt` (8,815 chars).

| Check | With `seccomp=default.json` | Without it |
|---|---|---|
| `/proc/self/status` → `Seccomp` | **2** (filter mode) | **2** (not 0, see below) |
| `Seccomp_filters` | **2** | **1** |
| `NoNewPrivs` / `CapEff` | 1 / `0000000000000000` | 1 / `0000000000000000` |
| `keyctl(KEYCTL_GET_KEYRING_ID, session)` (raw syscall 250) | **-1, errno 1 EPERM**: blocked | **succeeds** (returned a keyring ID) |
| `uid` | 65534(nobody) | 65534(nobody) |

**Surprising:** the request expected mode 0 without the flag, but every container already carries **one inherited, permissive seccomp filter**. This is most likely from Docker Desktop's containerized engine environment. Because the daemon itself runs with `profile=unconfined`, Docker's normal default profile is **not** applied, and syscalls such as `keyctl` that moby's profile denies are allowed. Passing the profile explicitly stacks a second filter (`Seccomp_filters: 2`) and restores the expected denials. **The runner must always pass the profile**; it cannot rely on daemon defaults, and the daemon must not be reconfigured.

## Results

| # | Check | Expected | Observed | Exit code / inspect fields |
|---|---|---|---|---|
| V1 | Network: `ls /sys/class/net`, `getent hosts example.com`, `bash` `/dev/tcp/1.1.1.1/80` | Fail | Only `lo` exists. `getent` rc=2 (not found). TCP connect: *"connect: Network is unreachable"*, rc=1 | Container ExitCode=0 (the script continued), `NetworkMode=none`, OOMKilled=false. **PASS** |
| V2 | Memory: `python3 -c "bytearray(512 MiB)"` (15 s timeout) | Terminated | **Still running at 15 s**, killed by the host timeout. Not OOM-killed within the window | At kill time: Status=running, OOMKilled=false, ExitCode=0. **Partial** (see V2 diagnostic) |
| V2-diag | Same limits, 8×64 MiB chunks, polled for 60 s | OOM kill | 64 MiB in 1.17 s, 128 in 6.43 s, 192 in 5.52 s; `docker stats` 122→191 MiB / 256 MiB at about 100% CPU; **OOM-killed at about 18 s** | Status=exited, **OOMKilled=true, ExitCode=137**. **PASS** (limit enforced) |
| V3 | PIDs: fork 100 × `sleep 30` | Spawn failures once ≈64 processes exist | First attempt in `sh` (dash): it aborted on the first failure with *"sh: 0: Cannot fork"*. Python retry: **started=63, failed=37**, error *"Resource temporarily unavailable"* (EAGAIN). `pids.current=64`, `pids.max=64` | dash run: ExitCode=2. Python run: ExitCode=0. **PASS** |
| V3 | Docker responsiveness during the fork test | Responsive | `docker version` latency during the runs: 399–1698 ms (dash run), 193–548 ms (Python run). Baseline 782 ms. `docker ps` afterwards: 388 ms. The host stayed usable | **PASS** |
| V4 | Time: `while true; do :; done` | Stopped by the host timeout and gone | At 15.2 s the client was killed, **but the container was still `Running=true`**. `docker rm -f` removed it, and `docker ps -a --filter name=judge-p0-v4` was empty | At kill time: Status=running, ExitCode=0. **PASS** with caveat (see Findings) |
| V5 | Read-only rootfs: write `/home/test.txt`, `/test.txt`, `/tmp/test.txt`; exec from `/tmp` | `/home` fails, `/tmp` succeeds | `/home` and `/`: *"Read-only file system"* (rc=2). `/tmp`: success, read back `hi`. `/proc/mounts`: `overlay / ... ro`, `tmpfs /tmp ... rw,nosuid,nodev,noexec,size=16384k`. Executing a script in `/tmp`: *"Permission denied"* (rc=126) | ExitCode=0, `ReadonlyRootfs=true`. **PASS** |
| V6 | Output: `head -c 50M /dev/zero` to stdout (+ marker) | Observe the client | The container **finished almost immediately** (Status=exited, ExitCode=0). The attached `docker start -a` client had relayed only **34,373,632 B in 15 s** (≈2.3 MB/s) when the host timeout killed it. Client peak working set ≈20 MB (it streams; no buffering). `docker logs` afterwards returned the full **52,428,813 B in 14.25 s** (≈3.5 MB/s), client peak 21.5 MB | ExitCode=0, OOMKilled=false. **Observation** (cap in runner) |

### Step 4: no-mount smoke test

| Attempt | Result |
|---|---|
| `docker create` (base flags) → `docker cp file c:/tmp/…` | **Fails**: `Error response from daemon: container rootfs is marked read-only`. This applies to both `/tmp` and `/`, because the tmpfs isn't mounted until start and the daemon refuses `cp` into read-only-rootfs containers. The containers then ran without their files (g++ "No such file", python "can't open file") |
| **Stdin delivery:** `docker create -i … sh -c 'cat > FILE && …'`, then `docker start -ai` with the source as redirected stdin | **Works, Mounts=0** |
| C++ (`gcc:14.2.0`): source to `/box/main.cpp`, `g++ -O2 -std=c++17`, run `/box/a.out` | stdout `Hello from C++ 14.2.0`, ExitCode=0, 4.44 s. Needed an extra `--tmpfs /box:rw,exec,size=32m` (**deviation from base flags**) |
| Python (`python:3.12.7-slim-bookworm`): source to `/tmp/main.py`, `python3 /tmp/main.py` | stdout `Hello from Python 3.12.7`, ExitCode=0, 1.28 s. No deviation (the interpreter only reads the file, so noexec doesn't matter) |
| Control: compile to noexec `/tmp/a.out` and run it | `sh: 1: /tmp/a.out: Permission denied`, ExitCode=126. Confirms noexec is enforced |

All smoke containers were removed and verified gone.

## Findings and implications for the Phase 1 runner

1. **Always pass the pinned seccomp profile.** Without it, the inherited filter allows syscalls like `keyctl`. Keep `sandbox/seccomp/default.json` versioned and consider tightening it further for judge workloads (e.g. deny `ptrace`, `process_vm_*`, `memfd_create`, `io_uring_*`).
2. **Killing the client ≠ killing the container (V4, V2, V6).** On timeout the runner must `docker kill <name>` (or `rm -f`) and verify removal. Name containers by a per-run UUID.
3. **Decide MLE vs TLE carefully (V2).** On this host, filling 256 MiB took about 18 s at 100% of one CPU (slow page-fault throughput in the WSL2 VM; the host had little free RAM). The kernel OOM kill can arrive after the wall-clock timeout. The runner should check `State.OOMKilled` and cgroup `memory.events` (`oom_kill`, `max`) before assigning TLE. Also consider a separate CPU-time limit (`ulimit -t` / RLIMIT_CPU) so TLE is CPU-based rather than wall-clock-based.
4. **Code delivery: use stdin, not `docker cp` (step 4).** `--read-only` and `docker cp` are incompatible. Recommended: stream a **tar** of {source, test input} on stdin and have a tiny trusted entrypoint extract it into tmpfs. Alternatively use `docker exec`/Engine API `PUT /archive`, which needs a writable target at create time and has the same problem. Avoid named volumes and bind mounts.
5. **Exec-able scratch area.** Keep `/tmp` noexec, and add a dedicated `--tmpfs /box:rw,exec,nosuid,nodev,size=…` for compiled binaries (or compile in one container and run the binary in another, with `/box` as the only exec-able writable path).
6. **Cap output in the runner (V6).** stdout via the Windows `docker` CLI runs at only ≈2–3.5 MB/s, and the `json-file` log driver stored the full 50 MB inside the VM (no `max-size` by default). Recommended:
   - read the attach stream and kill once it exceeds N KB, or use `head -c` inside a trusted wrapper;
   - use `--log-driver none` (or `--log-opt max-size=1m`) so output isn't persisted;
   - set `--ulimit fsize` to bound tmpfs file writes.
7. **dash aborts on fork failure (V3).** This is harmless for user programs, but a trusted wrapper script in `sh` must not depend on forking after the limit is hit.
8. **Pin images by digest**, and pre-pull them as part of worker startup.

## Docker Desktop and pre-existing state

Docker Desktop was **not running** at the start of the session. I started the app (`Docker Desktop.exe`) and did **not** change any setting, context or daemon configuration. Starting it caused containers with restart policies to start on their own (`job_platform_mysql`, `job_platform_redis`, `url_shortener_db`). `job_platform_backend` and `job_platform_frontend` entered a `Restarting (254)` loop. That is pre-existing behaviour of those containers, and I didn't touch them.

Before/after comparison (`docker ps -a`, `docker images`, `docker volume ls`, snapshotted before the first test and after the last):

| Resource | Before | After | Difference |
|---|---|---|---|
| Containers | 12 | 12 | Identical IDs, names and images. The only diffs are status *time text* (e.g. "Up 42 seconds" → "Up 42 minutes", "45 hours ago" → "46 hours ago", restart-loop timestamps) |
| Images | 43 | 46 | **0 removed or changed.** Added only the three pinned test images: `debian:bookworm-slim`, `gcc:14.2.0`, `python:3.12.7-slim-bookworm` (left in place for Phase 1; remove with `docker rmi` if unwanted) |
| Volumes | 36 | 36 | Identical |

The pre-existing `python:3.12-slim` tag was deliberately not pulled, so it wasn't moved.

Final check: `docker ps -a --filter name=judge-p0-` → **empty** (count 0).
