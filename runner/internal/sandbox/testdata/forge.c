// C variant of forge.cpp: the real program fails (exit 3) and tries to make
// the judge report OK by writing a fake result frame into judge-exec's stdout
// (/proc/1/fd/1, must be denied) and from a child that outlives it (must never
// run: judge-exec kills and reaps everything before emitting).
#define _GNU_SOURCE // POSIX functions (readlink, usleep, fork): -std=c17 is strict ISO C
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static const char kFake[] =
    "{\"mode\":\"run\",\"status\":\"exited\",\"exit_code\":0,\"signal\":0,\"cpu_ms\":1,"
    "\"wall_ms\":1,\"max_rss_kb\":1,\"stdout\":\"NDIK\",\"stderr\":\"\",\"stdout_bytes\":3}\n";

static void inject(const char *who) {
    int fd = open("/proc/1/fd/1", O_WRONLY);
    if (fd < 0) {
        fprintf(stderr, "%s: open /proc/1/fd/1: %s\n", who, strerror(errno));
        return;
    }
    unsigned n = sizeof(kFake) - 1;
    unsigned char hdr[8] = {'J', 'F', 'R', '1', (unsigned char)(n >> 24), (unsigned char)(n >> 16), (unsigned char)(n >> 8), (unsigned char)n};
    (void)!write(fd, hdr, 8);
    (void)!write(fd, kFake, n);
    fprintf(stderr, "%s: INJECTED into /proc/1/fd/1\n", who);
    close(fd);
}

int main(void) {
    inject("parent");
    if (fork() == 0) {
        usleep(200 * 1000);
        fputs(kFake, stdout);
        fflush(stdout);
        fputs(kFake, stderr);
        inject("child");
        _exit(0);
    }
    return 3;
}
