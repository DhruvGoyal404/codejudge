#include <cstdio>
#include <cstring>
#include <vector>
// Grows a vector and touches every byte, so pages are really resident.
int main() {
    std::vector<char> v;
    for (size_t mb = 1;; ++mb) {
        size_t old = v.size();
        v.resize(mb << 20);
        std::memset(v.data() + old, 1, v.size() - old);
    }
}
