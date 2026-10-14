// A crash (SIGSEGV) while other threads are alive must be RE immediately:
// with RLIMIT_CORE=0 a piped core_pattern still ran the dump and the program
// hung until the wall limit (TLE). judge-exec sets RLIMIT_CORE=1.
#include <chrono>
#include <thread>
#include <vector>
int main() {
    std::vector<std::thread> ts;
    for (int i = 0; i < 8; ++i) ts.emplace_back([] { std::this_thread::sleep_for(std::chrono::hours(1)); });
    *(volatile int *)nullptr = 1;  // SIGSEGV with threads alive
}
