#include <cstdio>
#include <unistd.h>
// Try to start 200 processes; the container's pids limit (64 tasks, shared
// with judge-exec's threads) must stop us well before that.
int main() {
    int started = 0, failed = 0;
    for (int i = 0; i < 200; ++i) {
        pid_t p = fork();
        if (p == 0) { pause(); _exit(0); }
        if (p > 0) ++started; else ++failed;
    }
    std::printf("started=%d failed=%d\n", started, failed);
    return 0;
}
