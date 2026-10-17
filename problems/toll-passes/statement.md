# Toll Passes

A delivery van crosses a city laid out as a grid of `R` rows and `C` columns of blocks.
Entering block `(i, j)` costs a toll of `t_ij` coins, the starting block (top-left) and the
final block (bottom-right) included. The van moves one block right or one block down at
a time.

The driver holds `K` passes; a pass waives the toll of one block on the route (at most one
pass per block). Print the least total toll the driver has to pay.

## Input
The first line contains `R`, `C` and `K` (1 <= R, C <= 200, 0 <= K <= 10).
Each of the next `R` lines contains `C` integers `t_ij` (0 <= t_ij <= 10^6).

## Output
Print the minimum total toll.
