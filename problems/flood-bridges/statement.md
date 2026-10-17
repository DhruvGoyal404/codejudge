# Flood Bridges

A river delta has `n` villages and `m` two-way roads; every village can reach every other
one. Some villages are joined by several roads, and a road may loop from a village back
to itself. In a flood, any single road may be washed away.

Emergency planners ask `q` questions `u v`: how many roads are there whose loss alone
would cut village `u` off from village `v`?

## Input
The first line contains `n`, `m` and `q` (1 <= n <= 100 000, n - 1 <= m <= 200 000, 1 <= q <= 100 000).
Each of the next `m` lines contains `a b` (1 <= a, b <= n). The roads connect all villages.
Each of the next `q` lines contains `u v` (1 <= u, v <= n).

## Output
Print `q` lines: the number of roads whose loss would separate `u` and `v`.
