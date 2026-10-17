// Deep recursion (depth 200000) must work: RLIMIT_STACK = the memory limit.
#include <stdio.h>
static int depth(int n) { volatile char pad[64]; pad[0] = (char)n; return n == 0 ? pad[0] : 1 + depth(n - 1); }
int main(void) { printf("%d\n", depth(200000)); return 0; }
