# CodeEditor — Pre-rebuild Audit

Audit date: 2026-10-11 · Scope: `E:\Dhruv\To_Complete_Projects\CodeEditor`. This was a read-only audit: nothing was modified, installed or committed, and this file is the only one created.
Goal context: rebuild this into a sandboxed LeetCode-style online judge.

**Bottom line:**
- The current code **cannot work on this machine**. On Windows, Node's `exec` hands the command to `cmd.exe`, which drops everything after the first newline, so Docker is never invoked. I verified this with a harmless probe (§2.1).
- Even on Linux, where it would run, it executes untrusted code with **no network isolation, no timeout and no resource limits**, as root, through a shared writable host directory. Concurrent requests also read and overwrite each other's files.
- **Verdict: full rewrite.** Roughly 0 lines are worth carrying over; the idea (one Docker container per submission) is the only thing to keep.

---

## 1. Inventory (every file read in full)

| File | Lines | Notes |
|---|---|---|
| `index.js` | 66 | The entire application |
| `package.json` | 16 | Declares only `express ^4.21.2`. `start` = `nodemon index.js` |
| `package-lock.json` | — | 69 packages, express 4.21.2 resolved |
| `Dockerfile` | 11 | `FROM gcc:latest`, `WORKDIR /app`, `CMD ["sh"]` |
| `temp/code.cpp` | 3 | Leftover sample submission |
| `temp/testCases.txt` | 2 | Leftover sample input (`input1`, `input2`) |
| `node_modules/` | — | express 4.21.2, body-parser 1.20.3 (transitive only). **nodemon not installed locally** (works here only because nodemon 3.1.9 is installed globally) |

There is no README, frontend, test, `.gitignore` or `.dockerignore`.

---

## 2. Request → Docker → response flow

**Step 1: Server setup.** Express listens on port 5000 on **all interfaces**, so it's reachable from the LAN:
```js
8   const port = 5000;
11  app.use(bodyParser.json());
12  app.use(bodyParser.urlencoded({ extended: true }));
64  app.listen(port, () => { ... });
```
`bodyParser` is `require`d (line 3) but isn't in `package.json`; it resolves only because express depends on it. The default JSON body limit is 100 kB.

**Step 2: Input is taken unvalidated.**
```js
15  app.post('/submit-code', (req, res) => {
16    const { code, testCases } = req.body;
```
There are no type checks. If `code` isn't a string, or `testCases` isn't an array, the next lines throw a `TypeError`. Express's default handler then returns a 500, and outside production that response includes a stack trace.

**Step 3: The code is written to fixed, shared host paths.**
```js
19    const codeFilePath = path.join(__dirname, 'temp', 'code.cpp');
20    const testCasesFilePath = path.join(__dirname, 'temp', 'testCases.txt');
21    const outputFilePath = path.join(__dirname, 'temp', 'output.txt');
24    fs.writeFileSync(codeFilePath, code);
28    fs.writeFileSync(testCasesFilePath, testCases.join('\n'));
```
Every request uses the same three filenames. The writes are synchronous, so they block the event loop. All test cases are concatenated into one stdin stream.

**Step 4: The code reaches the container through a bind mount.**
```js
32    const dockerCommand = `
33      docker run --rm -v //c/Users/Dell/Desktop/CodeEditor/temp:/app cpp-compiler sh -c "
34        echo 'Running Docker container';
35        g++ /app/code.cpp -o /app/a.out &&
36        echo 'Compilation completed';
37        /app/a.out < /app/testCases.txt > /app/output.txt &&
38        echo 'Execution completed and output saved to /app/output.txt';
39        cat /app/output.txt"
40    `;
44    exec(dockerCommand, (error, stdout, stderr) => {
```
- The source is **not** passed as an argument or on stdin. The host's `temp/` directory is bind-mounted **read-write** at `/app`.
- The container compiles with `g++` and runs `a.out`, with stdin redirected from `testCases.txt` and stdout written to `output.txt` inside the mount.
- The host path is hardcoded to `C:\Users\Dell\Desktop\CodeEditor\temp`, which is **not** where the project lives now. It also uses MSYS/Git-Bash path syntax (`//c/...`).
- The image `cpp-compiler` is assumed to exist (built manually from the Dockerfile; this isn't documented anywhere). I couldn't check whether it exists because the Docker engine is stopped (§4).

**Step 5: The response is built.**
```js
45      if (error) { ... return res.status(500).json({ error: 'Failed to execute Docker command' }); }
54      if (fs.existsSync(outputFilePath)) {
55        const output = fs.readFileSync(outputFilePath, 'utf8');
56        return res.status(200).json({ message: 'Code executed successfully!', output });
57      } else {
58        return res.status(500).json({ error: 'Output file not found after execution!' });
```
- A compile error or a non-zero exit from the program fails the `&&` chain, and the user gets a generic 500. Compiler diagnostics are only `console.log`ged on the server.
- The `stdout` that `exec` captured (including `cat output.txt`) is discarded. Instead the host re-reads `output.txt` from disk.

### 2.1 Blocker: on Windows the Docker command never runs (verified)
On win32, `child_process.exec` runs commands through `cmd.exe` (`ComSpec` = `C:\WINDOWS\system32\cmd.exe`, confirmed). `cmd /c` only executes up to the **first line feed**. The template literal on line 32 **starts with a newline**, so cmd executes an empty command and returns success.

Probe (harmless echo, no container):
```
exec('\n    echo FIRST_LINE\n    echo SECOND_LINE\n  ')  →  {"error":null,"stdout":"","stderr":""}
```
So on this machine, `/submit-code` never calls Docker. It returns either:
- **500 "Output file not found"**, which is the current state since `temp/output.txt` doesn't exist, or
- **200 with a stale `output.txt`** from some earlier run, presented as this request's result.

Run under Linux (or WSL) Node, `/bin/sh` would honour the newlines and the command would execute.

---

## 3. Security review of the execution path

Severity assumes the stated goal: running untrusted code from anyone who can reach the server.

| # | Severity | Issue | Evidence / impact |
|---|---|---|---|
| S1 | **CRITICAL** | **No network isolation** | No `--network none` (line 33). Submitted code gets full outbound network: downloading payloads, scanning or attacking the LAN, mining, and reaching cloud metadata endpoints if ever deployed to a VM. |
| S2 | **CRITICAL** | **No timeout, and containers are orphaned** | `exec()` has no `timeout` option (line 44), so `while(1);` hangs the request forever. `--rm` only cleans up after the container exits. Killing the `docker` CLI process (e.g. when exec's maxBuffer is exceeded) does **not** stop the container, so it keeps running and burning CPU. There's no `--name`, so nothing can `docker kill` it reliably. |
| S3 | **HIGH** | **No memory / CPU / PID / ulimit limits** | There's no `--memory`, `--memory-swap`, `--cpus`, `--pids-limit` or `--ulimit`. A fork bomb or a large allocation exhausts the Docker Desktop WSL2 VM, which is shared with every container and has no `.wslconfig` cap (it defaults to up to ~50% of host RAM and all 12 logical CPUs; see §4). |
| S4 | **HIGH** | **Read-write host bind mount shared across requests** | `-v …/temp:/app` (line 33). Untrusted code can write anything into the host's `temp/` directory: overwrite `code.cpp` / `testCases.txt` / `output.txt` for other users, or fill the host disk (nothing caps the size of `output.txt` or any other file). It could also replace `output.txt` with a symlink that the host server then reads (line 55). With Docker Desktop's Windows file sharing, how that symlink resolves is unclear; on a Linux host it would be an **arbitrary file read by the server**. |
| S5 | **HIGH** | **Runs as root with default capabilities** | No `--user`, `--cap-drop ALL`, `--security-opt no-new-privileges` or `--read-only`. The `gcc` image runs as root, and the whole toolchain (gcc, sh, apt) is available to the submitted program at runtime. Docker's default seccomp profile is the only hardening applied. |
| S6 | **HIGH** | **Race between concurrent requests** | The fixed paths (lines 19–21) are shared by all requests. Request B can overwrite A's `code.cpp` before A's container compiles it, and A then receives B's output (cross-user leak plus wrong results). There's no locking, no per-request directory and no queue. |
| S7 | **MEDIUM** | **Stale output served as fresh** | `output.txt` is never deleted before a run. Combined with §2.1 and S6, a previous user's output can be returned with a 200. |
| S8 | **MEDIUM** | **Unbounded output handling** | `exec`'s default `maxBuffer` is 1 MB. Exceeding it errors out and kills only the CLI (see S2). On the host, `readFileSync` (line 55) loads the whole `output.txt` into Node memory with no size cap, so a multi-GB output can crash the server. |
| S9 | **MEDIUM** | **No auth, rate limiting or concurrency cap; listens on 0.0.0.0** | Anyone on the network can trigger unlimited parallel gcc containers (the `gcc:latest` image is about 1.4 GB). This is a trivial denial of service. |
| S10 | **MEDIUM** | **Unvalidated input plus synchronous fs** | Wrong types cause a 500 that includes a stack trace outside production. The synchronous writes on lines 24/28 block the event loop for every request. |
| S11 | **LOW** | **Command injection: not currently exploitable, but fragile** | The command string is fully static: `code` and `testCases` go to files and are never interpolated into the shell string, so there's no injection today. But it uses `exec` (shell parsing) rather than `spawn`/`execFile` with an argument array. The first time a language name, filename or flag is interpolated, it becomes injectable. |
| S12 | **LOW** | **Unpinned, oversized image** | `FROM gcc:latest` isn't reproducible, the tag `cpp-compiler` is built by hand, and compile and run happen in the same container, so the compiler is present while user code runs. |
| S13 | **LOW** | **Logging** | The full Docker command, user program stdout/stderr and errors go to the console (lines 42, 50–51, 46). There's no structured logging or log-size control. |

---

## 4. Environment on this machine

| Item | Value |
|---|---|
| OS | Windows 11 Home Single Language, 25H2, build **26200.9457**, x64 |
| CPU | Intel Core i5-1235U: 10 cores (2P + 8E), 12 logical |
| RAM | **15.7 GB** total (only 2.4 GB free at the time of the check) |
| Node / npm | v22.19.0 / 10.9.3 |
| Go | go1.22.5 windows/amd64 |
| Git | 2.43.0.windows.1 |
| Local g++ | MinGW GCC 6.3.0 (very old; irrelevant if compiling in containers) |
| nodemon | 3.1.9 (global) |
| Docker CLI | 27.0.3 (API 1.46), context `desktop-linux` |
| Docker Desktop | **4.32.0** (mid-2024). Plugins: buildx 0.15.1, compose 2.28.1 |
| Docker engine | **NOT RUNNING.** `docker version` / `docker info` fail: `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.` The Docker Desktop process is not running. |
| Backend | **WSL2** (`settings.json` → `"wslEngineEnabled": true`). Distro `docker-desktop` (WSL v2, Stopped). Data disk relocated (`%LOCALAPPDATA%\Docker\wsl\disk` → `F:\WSL\DockerDisk\disk`); `main/ext4.vhdx` is about 629 MB |
| Storage driver / cgroup version | **Could not be read** because the engine is stopped. Expected: overlay2 (`"useContainerdSnapshotter": false`) and cgroup v2 (WSL kernel 5.15). Verify with `docker info` once Docker Desktop is started. |
| Docker Desktop resource settings | `cpus: 12`, `memoryMiB: 2048`, `diskSizeMiB: 65536`, `exposeDockerAPIOnTCP2375: false` (good). **With the WSL2 backend, the CPU/memory settings are ignored**; limits come from `%USERPROFILE%\.wslconfig`, which **does not exist**, so WSL defaults apply. |
| WSL | WSL 2.2.4.0, kernel 5.15.153.1-2, WSLg 1.0.61. Distros: `docker-desktop` (default, v2, Stopped), `Ubuntu-22.04` (v2, Stopped) |
| Missing | Nothing required is missing. Docker Desktop, the CLI and WSL are dated and worth updating before building. No gVisor/`runsc` (not available on Docker Desktop for Windows in any simple way). |

## 5. Docker smoke test
```
docker run --rm hello-world
docker: error during connect: Head "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/_ping":
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```
**Result: Docker does not work right now** because the Docker Desktop engine isn't started. I didn't start it, since that is a system state change outside the audit's scope. Starting Docker Desktop and rerunning `hello-world` is the next check.

## 6. Git
**Not a git repository** (`git rev-parse` → "not a git repository"; there's no `.git`, no remote and no history). There's also no `.gitignore`, so `node_modules/` and `temp/` would be committed if you ran `git init` and `git add .`.

---

## 7. Other functional defects (non-security)

| # | Defect |
|---|---|
| F1 | **Blocker:** the Docker command never runs on Windows (§2.1). |
| F2 | The hardcoded bind path points at the old Desktop location (line 33). |
| F3 | The `cpp-compiler` image must be built manually, and this isn't documented. |
| F4 | There are no judge verdicts. Compile error, runtime error, timeout and wrong answer all become a generic 500 or a raw output dump, and compiler messages are hidden from the user. |
| F5 | It's not a judge. All test cases are piped together as a single stdin, and there are no expected outputs, no per-test execution and no comparison. |
| F6 | The sample `temp/code.cpp` uses `'Hello, World!'` (single quotes = multi-character constant), so it prints an integer. |
| F7 | `npm start` depends on nodemon, which isn't declared, and `body-parser` isn't declared either. |
| F8 | Only C++ is supported, with no `-std`/`-O2` flags. |
| F9 | There's no frontend or editor, despite the folder name. |

---

## 8. Salvageable vs throwaway

| Part | Verdict |
|---|---|
| `index.js` handler logic | **Throw away.** Shared paths, `exec` with a shell string, no limits, broken on Windows. |
| Express bootstrap (`express()`, `express.json()`, `listen`) | Trivial boilerplate; easier to rewrite than to keep. |
| `Dockerfile` (`gcc:latest`, `CMD ["sh"]`) | **Throw away.** Replace with pinned, minimal per-language images that run as a non-root user. |
| `temp/` samples | Throw away. |
| `package.json` | Throw away; re-init with correct dependencies. |
| **The idea** (one container per submission, compile then run with stdin from tests) | **Keep.** It's the right basic shape. |

**Recommendation: a full rewrite.** Essentially nothing here constrains the new design. Points the rebuild must address, mapped to the findings above:

1. **Run the judge workers on Linux**, not through Docker Desktop on Windows: a native dockerd inside the existing `Ubuntu-22.04` WSL distro for development, and a Linux VM for anything public. This also avoids F1, and makes gVisor (`--runtime=runsc`) an option for stronger isolation.
2. **Never use `exec` with a shell string.** Use `spawn`/`execFile` with an argument array, or the Docker Engine API (e.g. `dockerode`). (S11, F1)
3. **Create a unique working directory per submission** (`fs.mkdtemp`), delete it afterwards, and allow no shared paths. Prefer passing source and input through `docker cp` or stdin over writable bind mounts; if a mount is needed, mount the binary **read-only**. (S4, S6, S7)
4. **Use separate compile and run steps**, ideally separate containers, so the compiler isn't present while user code runs. Run **each test case separately**, compare its output to the expected output, and return LeetCode-style verdicts (AC / WA / TLE / MLE / RE / CE). (F4, F5, S12)
5. **Harden every container:** `--network none --memory=256m --memory-swap=256m --cpus=1 --pids-limit=64 --read-only --tmpfs /tmp:rw,size=16m,noexec --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges --ulimit nofile=64 --ulimit fsize=…`, plus `--name <uuid>` so the container can be killed. (S1, S3, S5)
6. **Enforce a wall-clock timeout from the host** that runs `docker kill <name>` (and remove the container) on timeout or crash. Measure CPU time separately if you want TLE to be accurate. (S2)
7. **Cap output size** while streaming stdout (truncate after N KB) instead of reading files into memory. (S8)
8. **Put a job queue with a concurrency limit** in front of the workers (e.g. BullMQ/Redis or an in-process limiter), plus auth, rate limiting and request schema validation. Bind to localhost or sit behind a reverse proxy. (S9, S10)
9. **Pin image digests** and pre-pull the images. Add `.gitignore`/`.dockerignore` and `git init` from day one. (S12, §6)
10. **Before building, update Docker Desktop and WSL**, and add a `.wslconfig` that caps the VM's memory and CPU so a runaway job can't starve the laptop (15.7 GB RAM, with little free during the check).

An alternative worth evaluating instead of building the sandbox yourself: self-hosting **Judge0** (an open-source judge built on the `isolate` sandbox). You'd write only the problem/test-case layer and the UI on top of it.
