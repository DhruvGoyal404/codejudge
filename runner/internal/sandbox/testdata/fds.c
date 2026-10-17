// C variant of fds.cpp: lists every open file descriptor and its target.
#define _GNU_SOURCE // POSIX functions (readlink, usleep, fork): -std=c17 is strict ISO C
#include <dirent.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
    DIR *d = opendir("/proc/self/fd");
    if (!d) { perror("opendir"); return 1; }
    struct dirent *e;
    char path[64], target[512];
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.') continue;
        snprintf(path, sizeof path, "/proc/self/fd/%s", e->d_name);
        ssize_t n = readlink(path, target, sizeof target - 1);
        if (n < 0) continue;
        target[n] = 0;
        printf("fd %s -> %s\n", e->d_name, target);
    }
    closedir(d);
    return 0;
}
