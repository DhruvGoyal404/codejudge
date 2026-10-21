// Programs written for these specs and the screenshots they take (docs/img),
// so no private reference or wrong solution ever appears in a public image.

/** Range Ledger, correct: prefix sums, sum(l..r) = prefix[r] - prefix[l - 1]. */
export const RANGE_LEDGER_OK = `#include <iostream>
#include <vector>

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n, q;
    std::cin >> n >> q;
    std::vector<long long> prefix(n + 1, 0); // prefix[i] = b_1 + ... + b_i
    for (int i = 1; i <= n; ++i) {
        long long b;
        std::cin >> b;
        prefix[i] = prefix[i - 1] + b;
    }
    while (q--) {
        int l, r;
        std::cin >> l >> r;
        std::cout << prefix[r] - prefix[l - 1] << '\\n';
    }
}
`;

/** Range Ledger, off by one (drops day l): 14 7 0 instead of 15 9 3 on sample 01. */
export const RANGE_LEDGER_OFF_BY_ONE = RANGE_LEDGER_OK.replace("prefix[r] - prefix[l - 1]", "prefix[r] - prefix[l]");
