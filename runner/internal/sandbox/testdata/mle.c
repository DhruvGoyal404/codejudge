#include <stdlib.h>
#include <string.h>
// Allocates 1 MB blocks and touches every byte, so pages are really resident.
int main(void) {
    for (;;) {
        char *p = malloc(1 << 20);
        if (!p) return 1;
        memset(p, 1, 1 << 20);
    }
}
