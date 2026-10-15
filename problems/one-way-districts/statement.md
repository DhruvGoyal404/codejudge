# One-Way Districts

A city has `n` junctions and `m` one-way streets; street `j` leads from junction `u_j` to
junction `v_j`. The planners call a set of junctions a district when every junction of the
set can reach every other one along streets, and the set cannot be enlarged without
breaking that. Every junction belongs to exactly one district (possibly on its own).

Print the number of districts and the number of junctions in the largest one.

## Input
The first line contains `n` and `m` (1 <= n <= 200 000, 0 <= m <= 300 000).
Each of the next `m` lines contains `u_j v_j` (1 <= u_j, v_j <= n).

## Output
Print two integers: the number of districts and the size of the largest district.
