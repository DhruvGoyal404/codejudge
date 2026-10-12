#include <chrono>
#include <thread>
int main() { for (;;) std::this_thread::sleep_for(std::chrono::hours(1)); }
