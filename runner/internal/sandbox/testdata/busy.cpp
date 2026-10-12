int main() { volatile unsigned long long x = 0; for (;;) { x = x + 1; } }
