// Reads its input to EOF, then keeps trying to read more. Must never receive
// bytes belonging to a later test.
#include <cstdio>
#include <string>
#include <unistd.h>
int main() {
    std::string own;
    char buf[4096];
    ssize_t n;
    while ((n = read(0, buf, sizeof buf)) > 0) own.append(buf, n);
    long extra = 0;
    std::string extraData;
    for (int i = 0; i < 20; ++i) {
        usleep(50 * 1000);
        while ((n = read(0, buf, sizeof buf)) > 0) { extra += n; extraData.append(buf, n); }
    }
    std::printf("own=%s extra=%ld extradata=%s\n", own.c_str(), extra, extraData.c_str());
    return 0;
}
