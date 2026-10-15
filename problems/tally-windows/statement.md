# Tally Windows

A cashier's ledger lists `n` signed amounts `a_1 ... a_n` (refunds are negative). An
auditor wants to know how many windows of consecutive entries add up to exactly `K`: the
number of pairs `l <= r` with `a_l + a_{l+1} + ... + a_r = K`.

## Input
The first line contains `n` and `K` (1 <= n <= 200 000, -10^15 <= K <= 10^15).
The second line contains `n` integers `a_1 ... a_n` (-10^9 <= a_i <= 10^9).

## Output
Print the number of windows whose sum is exactly `K`.
