// TEMPORARY (runsc-diag): what do process-creation syscalls return under
// our seccomp profile? Compiled statically, run under each runtime.
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
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
    long p = syscall(SYS_clone, CLONE_VM | CLONE_VFORK | SIGCHLD, 0, 0, 0, 0);
    if (p == 0) syscall(SYS_exit, 0);
    printf("clone(VM|VFORK|SIGCHLD): r=%ld errno=%d (%s)\n", p, errno, strerror(errno));
    if (p > 0) waitpid((pid_t)p, NULL, 0);

    errno = 0;
    pid_t f = fork();
    if (f == 0) _exit(0);
    printf("fork: r=%d errno=%d (%s)\n", f, errno, strerror(errno));
    if (f > 0) waitpid(f, NULL, 0);

    pid_t sp;
    char *argv[] = {"true", NULL};
    int e = posix_spawn(&sp, "/bin/true", NULL, NULL, argv, environ);
    printf("posix_spawn(/bin/true): %d (%s)\n", e, strerror(e));
    if (e == 0) waitpid(sp, NULL, 0);
    return 0;
}
