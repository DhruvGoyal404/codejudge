// clone3 behaviour per runtime: plain (fork-like) and with namespace flags.
// runc:  the profile maps clone3 to ENOSYS (glibc then uses clone, whose
//        flags the profile filters).
// runsc: clone3 is allowed (gVisor variant); namespace creation must still
//        fail (no capabilities, no-new-privileges).
#include <cerrno>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef SYS_clone3
#define SYS_clone3 435
#endif

struct clone_args_v0 {
    uint64_t flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls;
};

static void attempt(const char *name, uint64_t flags) {
    clone_args_v0 a{};
    a.flags = flags;
    a.exit_signal = SIGCHLD;
    errno = 0;
    long r = syscall(SYS_clone3, &a, sizeof a);
    if (r == 0) _exit(0);  // child
    if (r > 0) {
        waitpid((pid_t)r, nullptr, 0);
        std::printf("%s: ok\n", name);
    } else {
        std::printf("%s: errno=%d (%s)\n", name, errno, std::strerror(errno));
    }
}

int main() {
    attempt("plain", 0);
    attempt("newuser", 0x10000000);  // CLONE_NEWUSER
    attempt("newpid", 0x20000000);   // CLONE_NEWPID
    attempt("newns", 0x00020000);    // CLONE_NEWNS
    return 0;
}
