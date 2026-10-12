#include <cerrno>
#include <cstdio>
#include <cstring>
#include <sys/syscall.h>
#include <unistd.h>
// keyctl(KEYCTL_GET_KEYRING_ID=0, KEY_SPEC_SESSION_KEYRING=-3, create=0).
// moby's default seccomp profile denies keyctl with EPERM.
int main() {
    long r = syscall(SYS_keyctl, 0, -3, 0);
    if (r < 0) std::printf("keyctl errno=%d %s\n", errno, errno == EPERM ? "EPERM" : std::strerror(errno));
    else std::printf("keyctl allowed id=%ld\n", r);
    return 0;
}
