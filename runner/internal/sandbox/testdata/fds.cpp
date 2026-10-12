// Lists every open file descriptor and its target. In batch mode only the
// test's own input, the stdout/stderr files and the directory being listed
// may appear -- never judge-exec's protocol pipes.
#include <dirent.h>
#include <cstdio>
#include <cstdlib>
#include <unistd.h>
int main() {
    DIR *d = opendir("/proc/self/fd");
    if (!d) { std::perror("opendir"); return 1; }
    struct dirent *e;
    char path[64], target[512];
    while ((e = readdir(d)) != nullptr) {
        if (e->d_name[0] == '.') continue;
        std::snprintf(path, sizeof path, "/proc/self/fd/%s", e->d_name);
        ssize_t n = readlink(path, target, sizeof target - 1);
        if (n < 0) continue;
        target[n] = 0;
        std::printf("fd %s -> %s\n", e->d_name, target);
    }
    closedir(d);
    return 0;
}
