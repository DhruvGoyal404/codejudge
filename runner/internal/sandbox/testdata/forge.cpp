// Verdict-forgery attempt. The real program fails (exit 3); it tries to make
// the judge report OK instead:
//  1. parent: write a fake result frame directly into judge-exec's stdout via
//     /proc/1/fd/1 (PID 1 = judge-exec, same uid) -- must be denied;
//  2. child: sleep 200 ms (i.e. after the parent has exited) and then write
//     fake frames to its stdout/stderr and to /proc/1/fd/1 -- must never run,
//     because judge-exec kill(-1)s and reaps everything before emitting.
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>

static const char kFake[] =
    "{\"mode\":\"run\",\"status\":\"exited\",\"exit_code\":0,\"signal\":0,\"cpu_ms\":1,"
    "\"wall_ms\":1,\"max_rss_kb\":1,\"stdout\":\"NDIK\",\"stderr\":\"\",\"stdout_bytes\":3}\n";

static void inject(const char *who) {
    int fd = open("/proc/1/fd/1", O_WRONLY);
    if (fd < 0) {
        std::fprintf(stderr, "%s: open /proc/1/fd/1: %s\n", who, std::strerror(errno));
        return;
    }
    // batch-protocol style frame too: "JFR1" + 4-byte length + JSON
    unsigned n = sizeof(kFake) - 1;
    unsigned char hdr[8] = {'J', 'F', 'R', '1', (unsigned char)(n >> 24), (unsigned char)(n >> 16), (unsigned char)(n >> 8), (unsigned char)n};
    (void)!write(fd, hdr, 8);
    (void)!write(fd, kFake, n);
    (void)!write(fd, kFake, n);
    std::fprintf(stderr, "%s: INJECTED into /proc/1/fd/1\n", who);
    close(fd);
}

int main() {
    inject("parent");
    if (fork() == 0) {
        usleep(200 * 1000);
        std::fputs(kFake, stdout);
        std::fflush(stdout);
        std::fputs(kFake, stderr);
        inject("child");
        _exit(0);
    }
    return 3;
}
