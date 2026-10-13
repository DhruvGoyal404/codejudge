# judge-exec batch protocol (v1)

Batch mode runs **one container per submission**. The program artifact is sent once, and test inputs are sent one at a time. This document specifies the byte-level protocol between the host runner and `judge-exec` (PID 1 inside the container). Reference implementation: `runner/internal/protocol/framing.go`.

The transport is the container's attached stdio, with a non-TTY multiplexed stream:

- **Host → judge-exec:** container stdin, which stays open for the whole batch (`OpenStdin=true`, `StdinOnce=false`).
- **judge-exec → host:** container stdout. Container stderr carries only judge-exec's own diagnostics and is never parsed.

All integers are unsigned 32-bit **big-endian**.

## Host → judge-exec: messages

```
+------+-----------------+--------------------+
| type | length (u32 BE) | payload (length B) |
+------+-----------------+--------------------+
  1 B         4 B
```

| Type | Byte | Payload | Rules |
|---|---|---|---|
| Program | `'P'` (0x50) | `nonce (16 B) ‖ tar` | Must be the **first** message and is sent **exactly once**. The tar holds only the program files (C++: the static binary `main`; Python: `main.py`). No test data. Payload length ≥ 16. |
| Test | `'T'` (0x54) | the test's raw stdin bytes | The host sends one per test, and sends the next only **after** receiving the previous test's result frame. A zero-length payload is valid (empty input). |
| End | `'E'` (0x45) | none | Length must be 0. judge-exec exits with status 0. |

Any other type byte is a protocol error.

## judge-exec → host: result frames

```
+--------+-----------------+-------------------------+
| "JFR1" | length (u32 BE) | JSON Frame (length B)   |
+--------+-----------------+-------------------------+
   4 B          4 B
```

A frame is written with a single `write(2)` and is never interleaved with another frame. The JSON body is `protocol.Frame`. In batch mode, `mode` is `"batch"`, and `stdout`/`stderr` are base64, as in run mode.

| Frame | When | Key fields |
|---|---|---|
| **ready** | after a valid `P` message has been verified and extracted | `status: "ready"`, `seq: 0`, `nonce` |
| **result** | after each `T` message, once the program has finished, every other process has been killed and reaped, and the work directory has been reset | `seq` = 1-based test number, `nonce`, `status` (`exited` / `signaled` / `wall_killed` / `mem_killed`), `exit_code`, `signal`, `cpu_ms`, `wall_ms`, `max_rss_kb`, capped `stdout`/`stderr` and truncation flags, `output_limit_hit` |
| **error** | on any protocol or internal failure | `status: "error"`, `error` (message), plus `seq`/`nonce` if known. judge-exec then exits with a non-zero status |

### `seq` and `nonce`

- **nonce:** the host generates 16 random bytes per batch and sends them at the start of `P`. judge-exec echoes them, hex-encoded, in **every** frame. The host must reject a frame whose `nonce` differs, treating it as an internal error and ending the batch. The program never has access to the nonce: it isn't written into `/box`, and judge-exec's memory is protected by `PR_SET_DUMPABLE=0`. So a frame that somehow reached the host from anywhere other than judge-exec could not carry a valid nonce.
- **seq:** `0` for the ready frame, then `1, 2, 3…`, one per `T` message, in order. The host must reject a frame whose `seq` is not the next expected value.
- **ready:** the host must not send any `T` message until it has received the ready frame.

## Size limits

| Item | Limit | Enforced by |
|---|---|---|
| `P` payload | 16 B nonce + `--max-tar-bytes` (program tar) | judge-exec `ReadMsg(maxPayload)`: rejected **before** allocating |
| `T` payload | `--max-input-bytes`, which the host sets from the problem's largest input (≤ 16 MiB) | judge-exec `ReadMsg(maxPayload)` |
| `E` payload | 0 | judge-exec |
| Result frame JSON | ≈ 4/3 × (output limit + stderr cap) + 64 KiB envelope | host `ReadFrame(maxLen)`: rejected before allocating |
| Program tar contents | `--max-files` entries; regular files only; no absolute paths, `..`, links or devices | `internal/boxtar` |

**Error handling:**
- A length field above its limit is reported as `ErrTooLarge` without reading the payload.
- End of stream inside a header or payload is `ErrTruncated`.
- End of stream exactly at a message boundary is a clean `io.EOF`. judge-exec treats a clean EOF on stdin like `E`.

## Ordering guarantees per test

judge-exec handles each `T` message in this order:

1. Re-extract the program files from judge-exec's in-memory copy of the `P` tar, so every test starts from a pristine program.
2. Write the payload to `/box/input`, mode `0400`.
3. Run the program with fresh rlimits. Its stdin is `/box/input`, and its stdout/stderr are files in `/box`. All other judge-exec descriptors are close-on-exec.
4. Wait for it to exit or be killed.
5. Kill and reap every other process in the container.
6. Read the capped outputs.
7. Reset `/box`, `/tmp` and `/dev/mqueue` (and `/dev/shm` if present; containers run with `--ipc none`, so it isn't mounted).
8. Remove every System V IPC object listed in `/proc/sysvipc/{shm,msg,sem}` with `IPC_RMID`, and verify the tables are empty.
9. Emit the result frame.

If step 7 or 8 fails, judge-exec emits an **error** frame and exits: a test never runs in a dirty container.

Because the result frame is written only after step 5, nothing the program started can still be running when the host receives the result. Because the host sends the next `T` only after that frame arrives, inputs for later tests are never inside the container before their turn.

## Host rules

- Reject any frame whose `nonce` differs from the one sent in `P`, or whose `seq` is not the next expected value: the submission gets IE and the container is force-removed.
- Exception: a frame with the correct nonce and `status: "error"` is judge-exec reporting its own failure. It may carry the previous `seq` (for example, when the input was rejected before the test started). Report it as IE with its message, and end the batch.
- A failed stdin write, a broken result stream, or no frame within the per-test guard (wall limit + 5 s) means the container died: wait for it to stop, read `State.OOMKilled` (MLE if set, else IE), force-remove it, and never reuse it.
