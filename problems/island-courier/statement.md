# Island Courier

A courier boat serves `n` islands numbered `1` to `n`. Sailing from island `i` to island
`j` costs `c_ij` litres of fuel; because of currents, `c_ij` and `c_ji` may differ. The
boat leaves island `1`, must visit every other island exactly once, and returns to
island `1`.

Print the smallest possible total fuel for such a round trip.

## Input
The first line contains `n` (2 <= n <= 13).
Each of the next `n` lines contains `n` integers: line `i` holds `c_i1 ... c_in`
(`c_ii = 0`; otherwise 1 <= c_ij <= 10^6).

## Output
Print the minimum total fuel.
