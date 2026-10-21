# gVisor issue: clone3(CLONE_NEWNS) succeeds without CAP_SYS_ADMIN

Text of the public issue filed on google/gvisor.
Filed as: [google/gvisor#16118](https://github.com/google/gvisor/issues/16118)

---

**Title:** `clone3(CLONE_NEWNS)` succeeds for a task without `CAP_SYS_ADMIN` (Linux returns `EPERM`)

## Summary

Inside a runsc sandbox, a task with no capabilities can create a new mount
namespace with `clone3()` and `CLONE_NEWNS`. The task runs as a non-root uid
with all capabilities dropped and `no_new_privs` set. On Linux, `CLONE_NEWNS`
requires `CAP_SYS_ADMIN` in the caller's user namespace, so the call fails
with `EPERM` (clone(2), "EPERM … CLONE_NEWNS … was specified by an
unprivileged process").

In the same sandbox, `clone3(CLONE_NEWPID)` correctly fails with `EPERM`. So
the capability check looks missing on the `CLONE_NEWNS` path of `clone3`.

This was first reported privately to gvisor-security@googlegroups.com on
2026-10-21. The security team classified it as an in-sandbox Linux emulation
bug, not a vulnerability under gVisor's security policy, and asked for a
public issue.

## Versions

- gVisor `release-20260921.0`, platform systrap, registered with
  `runsc install -- --oci-seccomp`.
- Docker Engine 28.0.4 (API 1.48).
- Host: Ubuntu 24.04 (GitHub Actions `ubuntu-24.04`, image 20261004),
  kernel 6.17.0-1022-azure, cgroup v2.
- Container image `gcc:14.2.0` (Debian 12, glibc 2.36). The test binary is
  static.
- Not yet re-checked on a newer gVisor release.

## Reproduction

`clone3_ns.c`, built with `gcc -O1 -static -o clone3_ns clone3_ns.c`:

```c
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef SYS_clone3
#define SYS_clone3 435
#endif
struct clone_args_v0 { uint64_t flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls; };
static void attempt(const char *name, uint64_t flags) {
    struct clone_args_v0 a = {0};
    a.flags = flags; a.exit_signal = SIGCHLD;
    errno = 0;
    long r = syscall(SYS_clone3, &a, sizeof a);
    if (r == 0) _exit(0);
    if (r > 0) { waitpid((pid_t)r, NULL, 0); printf("%s: ok\n", name); }
    else printf("%s: errno=%d (%s)\n", name, errno, strerror(errno));
}
int main(void) {
    attempt("newns", 0x00020000);   // CLONE_NEWNS
    attempt("newpid", 0x20000000);  // CLONE_NEWPID
    return 0;
}
```

Run it unprivileged, with all capabilities dropped. The seccomp profile is
Docker's default profile with its `clone3` rule (`SCMP_ACT_ERRNO`,
`errnoRet: 38`) replaced by `SCMP_ACT_ALLOW`. Without that change, `clone3`
can't be called at all under `--oci-seccomp`; see the related issue below.

```sh
docker run --rm --runtime runsc --network none --cap-drop ALL \
  --security-opt no-new-privileges --user 1000000000:1000000000 \
  --security-opt seccomp=profile-with-clone3-allowed.json \
  -v "$PWD:/p:ro" --entrypoint /p/clone3_ns gcc:14.2.0
```

## Expected vs actual

| Call | Expected (Linux semantics) | runsc (actual) |
|---|---|---|
| `clone3(CLONE_NEWNS)` | `EPERM` | **ok** (the child is created) |
| `clone3(CLONE_NEWPID)` | `EPERM` | `EPERM` |

## Notes

- `clone3(CLONE_NEWUSER)` also succeeds. That matches Linux, where
  unprivileged user namespaces are allowed, so it isn't part of this issue.
- We haven't checked whether `unshare(CLONE_NEWNS)` or `clone(CLONE_NEWNS)`
  behave the same way. Docker's default seccomp profile blocks those flags
  before gVisor sees them.

Related: `--oci-seccomp` ignores `errnoRet`: [google/gvisor#16119](https://github.com/google/gvisor/issues/16119)
