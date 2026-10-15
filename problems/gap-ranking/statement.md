# Gap Ranking

`n` weather balloons float at altitudes `a_1 ... a_n` metres. For every pair of different
balloons `i < j` the gap is `|a_i - a_j|`. There are `n(n-1)/2` gaps; sort them from
smallest to largest.

Print the `k`-th gap in that order (gaps that are equal are listed as many times as they
occur).

## Input
The first line contains `n` and `k` (2 <= n <= 50 000, 1 <= k <= n(n-1)/2).
The second line contains `n` integers `a_1 ... a_n` (0 <= a_i <= 10^9).

## Output
Print the `k`-th smallest gap.
