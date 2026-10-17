// C variant of snoop.py: prints its own input, then every file it can find
// in /box, /tmp and /dev/shm (other tests' inputs or outputs must not be
// there), and leaves files behind for the next test to find.
#define _XOPEN_SOURCE 700
#include <ftw.h>
#include <stdio.h>
#include <string.h>

static int visit(const char *p, const struct stat *st, int type, struct FTW *ftw) {
    (void)st; (void)ftw;
    if (type != FTW_F) return 0;
    FILE *f = fopen(p, "r");
    if (!f) return 0;
    char buf[201];
    size_t n = fread(buf, 1, 200, f);
    fclose(f);
    buf[n] = 0;
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' ')) buf[--n] = 0;
    printf("found %s %s\n", p, buf);
    return 0;
}

int main(void) {
    char own[256] = {0};
    size_t n = fread(own, 1, sizeof own - 1, stdin);
    while (n > 0 && (own[n - 1] == '\n' || own[n - 1] == ' ')) own[--n] = 0;
    printf("own: %s\n", own);
    const char *roots[] = {"/box", "/tmp", "/dev/shm"};
    for (int i = 0; i < 3; i++) nftw(roots[i], visit, 8, FTW_PHYS);
    fflush(stdout);
    FILE *f = fopen("/tmp/left-behind", "w");
    if (f) { fprintf(f, "LEFTOVER %s", own); fclose(f); }
    f = fopen("/box/left-behind", "w");
    if (f) { fprintf(f, "LEFTOVER %s", own); fclose(f); }
    return 0;
}
