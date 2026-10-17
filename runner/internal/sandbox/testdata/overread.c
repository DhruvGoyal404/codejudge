// C variant of overread.cpp: reads its input to EOF, then keeps trying to
// read more. Must never receive bytes belonging to a later test.
#define _GNU_SOURCE // POSIX functions (readlink, usleep, fork): -std=c17 is strict ISO C
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(void) {
    static char own[1 << 16], extra[1 << 16];
    size_t olen = 0, elen = 0;
    char buf[4096];
    ssize_t n;
    while ((n = read(0, buf, sizeof buf)) > 0) {
        if (olen + n < sizeof own) { memcpy(own + olen, buf, n); olen += n; }
    }
    for (int i = 0; i < 20; ++i) {
        usleep(50 * 1000);
        while ((n = read(0, buf, sizeof buf)) > 0) {
            if (elen + n < sizeof extra) { memcpy(extra + elen, buf, n); elen += n; }
        }
    }
    own[olen] = 0;
    extra[elen] = 0;
    printf("own=%s extra=%zu extradata=%s\n", own, elen, extra);
    return 0;
}
