# Exhibit Variety

A museum corridor displays `n` exhibits in a row; exhibit `i` belongs to collection
`c_i`. Visitors walk a stretch of the corridor from exhibit `l` to exhibit `r`. For each
of `q` planned walks, the guide wants to know how many different collections the visitor
will see.

## Input
The first line contains `n` and `q` (1 <= n, q <= 100 000).
The second line contains `n` integers `c_1 ... c_n` (1 <= c_i <= 10^9).
Each of the next `q` lines contains `l r` (1 <= l <= r <= n).

## Output
Print `q` lines: the number of distinct collections among exhibits `l..r`.
