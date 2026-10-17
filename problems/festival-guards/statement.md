# Festival Guards

A hill festival has `n` stages connected by `n - 1` footpaths so that every stage can be
reached from every other one in exactly one way. Guarding stage `i` earns the security
company `g_i` coins. To avoid doubling up, the company never guards two stages joined
directly by a footpath.

Print the largest total the company can earn.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `g_1 ... g_n` (1 <= g_i <= 10^9).
Each of the next `n - 1` lines contains `u v` (1 <= u, v <= n): a footpath between stages
`u` and `v`.

## Output
Print the largest total.
