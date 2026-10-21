# gVisor issue: `--oci-seccomp` ignores `errnoRet`

Text for a public issue on google/gvisor, to be filed by the repository owner.
Filed as: <ISSUE URL: errnoRet>

---

**Title:** `--oci-seccomp` ignores `errnoRet` (per-rule and `defaultErrnoRet`); denied syscalls always return EPERM, which breaks glibc's clone3 → clone fallback

## Summary

With `runsc --oci-seccomp`, a container's OCI seccomp profile is applied inside the sandbox. However, the `errnoRet` field is ignored, both on individual rules and as the profile's `defaultErrnoRet`, and every syscall denied with `SCMP_ACT_ERRNO` fails with `EPERM`. runc honours both fields.

This matters in practice. Docker's default profile maps `clone3` to `SCMP_ACT_ERRNO` with `errnoRet: 38` (`ENOSYS`), because seccomp can't inspect `clone3`'s flags. glibc ≥ 2.34 uses `clone3` in `posix_spawn` and `pthread_create`, and falls back to `clone(2)` **only on ENOSYS**. Under `runsc --oci-seccomp` it gets EPERM and doesn't fall back, so `posix_spawn` and `pthread_create` fail for any image using Docker-style profiles. For example, `g++` can't start `cc1plus`, and every multithreaded program fails.

## Versions

- gVisor `release-20260921.0` (`runsc version release-20260921.0`, spec 1.2.1), platform systrap
- Docker Engine 28.0.4 (API 1.48), runc 1.5.2 for comparison
- Host: Ubuntu 24.04 (GitHub Actions `ubuntu-24.04` runner image 20261004), kernel 6.17.0-1022-azure, cgroup v2
- Container image: `gcc:14.2.0` (Debian 12 bookworm, glibc 2.36); the probe is a static binary built in that image
- Not yet re-checked on a newer gVisor release

`runsc` was registered with `runsc install -- --oci-seccomp`. The debug log shows `Config.OCISeccomp (--oci-seccomp): true`, and the spec passed to `runsc boot` contains the rule with `"errnoRet": 38`.

## Minimal reproduction

`probe.c` (build statically: `gcc -O1 -static -o probe probe.c`):

```c
#define _GNU_SOURCE
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;

int main(void) {
    errno = 0;
    long r = syscall(SYS_clone3, NULL, 0);
    printf("clone3(NULL,0): r=%ld errno=%d (%s)\n", r, errno, strerror(errno));
    errno = 0;
    r = syscall(SYS_keyctl, 0, 0, 0, 0, 0);
    printf("keyctl: r=%ld errno=%d (%s)\n", r, errno, strerror(errno));
    pid_t pid; char *argv[] = {"true", NULL};
    int e = posix_spawn(&pid, "/bin/true", NULL, NULL, argv, environ);
    printf("posix_spawn: %d (%s)\n", e, strerror(e));
    if (e == 0) waitpid(pid, NULL, 0);
    return 0;
}
```

`profile.json`: Docker's default seccomp profile (moby `profiles/seccomp/default.json`). Its relevant rule is:

```json
{ "names": ["clone3"], "action": "SCMP_ACT_ERRNO", "errnoRet": 38,
  "excludes": { "caps": ["CAP_SYS_ADMIN"] } }
```

`keyctl` isn't allowed, so it falls through to `defaultAction: SCMP_ACT_ERRNO`.

Run (as an unprivileged user, capabilities dropped):

```sh
for rt in runc runsc; do
  docker run --rm --runtime $rt --security-opt seccomp=profile.json \
    --cap-drop ALL --user 65534 -v "$PWD:/p:ro" --entrypoint /p/probe <image with /bin/true>
done
```

To check `defaultErrnoRet`, repeat with `jq '.defaultErrnoRet = 38' profile.json > enosys.json`.

## Expected vs actual

| | runc | runsc `--oci-seccomp` (expected) | runsc `--oci-seccomp` (actual) |
|---|---|---|---|
| `clone3` (rule `errnoRet: 38`) | ENOSYS | ENOSYS | **EPERM** |
| `keyctl` (default, `defaultErrnoRet: 1`) | EPERM | EPERM | EPERM |
| `keyctl` with `defaultErrnoRet: 38` | ENOSYS | ENOSYS | **EPERM** |
| `posix_spawn("/bin/true")` | 0 | 0 | **EPERM** |
| same with `--security-opt seccomp=unconfined` | 0 | 0 | 0 |

`fork()` and `clone(CLONE_VM|CLONE_VFORK|SIGCHLD)` work under both runtimes, so only the `clone3` path breaks, and only because of the errno.

## Impact

- Any workload whose profile maps `clone3` to ENOSYS (Docker's default does) can't spawn processes through `posix_spawn` or create threads with `pthread_create` under `runsc --oci-seccomp`. That covers compilers (g++ → cc1plus), JVMs, Node.js, and C++/Python threading.
- The workaround is to allow `clone3` outright in the profile used with runsc. That gives up the reason the profile denies it in the first place: seccomp cannot inspect clone3's flags. With `clone3` allowed, namespace flags reach gVisor's own checks; one of them is missing: <ISSUE URL: clone3 CLONE_NEWNS>.

## Suggested fix

When converting the OCI `LinuxSeccomp` spec, honour `errnoRet` on each syscall rule and `defaultErrnoRet` on the profile. If a profile asks for an errno that can't be honoured, failing closed with an error at container start would be preferable to substituting EPERM.
