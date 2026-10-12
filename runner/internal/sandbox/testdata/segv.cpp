#include <cstdio>
int main() { volatile int *p = nullptr; *p = 42; std::puts("unreachable"); return 0; }
