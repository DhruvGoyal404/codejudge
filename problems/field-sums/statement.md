# Field Sums

A farm survey divides a field into a grid of `R` rows and `C` columns of plots; plot
`(i, j)` yielded `a_ij` kilograms (negative values are losses). The farmer asks `q`
questions: what was the total yield of the rectangle of plots from row `r_1` to row `r_2`
and from column `c_1` to column `c_2` (inclusive)?

## Input
The first line contains `R`, `C` and `q` (1 <= R, C <= 1000, 1 <= q <= 100 000).
Each of the next `R` lines contains `C` integers `a_ij` (-10^6 <= a_ij <= 10^6).
Each of the next `q` lines contains `r_1 c_1 r_2 c_2` (1 <= r_1 <= r_2 <= R, 1 <= c_1 <= c_2 <= C).

## Output
Print `q` lines: the total yield of each rectangle.
