// TEMPORARY (runsc-diag): which errno do denied syscalls return?
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static void show(const char *name, long r) {
    printf("%s: r=%ld errno=%d (%s)\n", name, r, errno, strerror(errno));
}

int main(void) {
    errno = 0; show("shmget", syscall(SYS_shmget, 0, 4096, 01000 | 0600));
    errno = 0; show("keyctl", syscall(SYS_keyctl, 0, 0, 0, 0, 0));
    errno = 0; show("mq_open", syscall(SYS_mq_open, "/x", 0100, 0600, 0));
    errno = 0; show("unshare(CLONE_NEWUSER)", syscall(SYS_unshare, 0x10000000));
    return 0;
}
