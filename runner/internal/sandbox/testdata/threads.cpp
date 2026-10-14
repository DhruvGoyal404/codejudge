// Multithreading must work under both runtimes: glibc's pthread_create uses
// clone3 (falls back to clone only on ENOSYS). 8 threads sum disjoint ranges.
#include <cstdio>
#include <thread>
#include <vector>
int main() {
    const int T = 8;
    std::vector<long long> part(T, 0);
    std::vector<std::thread> ts;
    for (int t = 0; t < T; ++t)
        ts.emplace_back([t, &part] { for (long long i = t; i < 1000000; i += T) part[t] += i; });
    for (auto &th : ts) th.join();
    long long sum = 0;
    for (long long p : part) sum += p;
    std::printf("threads=%d sum=%lld\n", T, sum);
    return 0;
}
