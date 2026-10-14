// Starts threads until creation fails, without handling the failure: the
// uncaught std::system_error must end the program (abort -> RE) while
// judge-exec stays alive to report it (never IE).
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>
int main() {
    std::vector<std::thread> ts;
    for (int i = 0; i < 100000; ++i) {
        ts.emplace_back([] { std::this_thread::sleep_for(std::chrono::hours(1)); });
        if (i % 8 == 0) std::fprintf(stderr, "started %d\n", i + 1);
    }
    std::puts("unreachable: no process limit");
    return 0;
}
