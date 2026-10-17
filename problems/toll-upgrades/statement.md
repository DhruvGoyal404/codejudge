# Toll Upgrades

A county has `n` towns joined by `m` two-way roads; road `j` between towns `a_j` and `b_j`
takes `w_j` minutes. Every town can reach every other one.

The council publishes a **connectivity score**: the sum, over all pairs of towns `u < v`,
of the shortest travel time between them. Then it opens `q` new roads one after another;
road `k` joins `u_k` and `v_k` and takes `t_k` minutes. After each opening, print the new
score.

## Input
The first line contains `n`, `m` and `q` (2 <= n <= 200, n - 1 <= m <= 20 000, 1 <= q <= 200).
Each of the next `m` lines contains `a_j b_j w_j` (1 <= a_j, b_j <= n, 1 <= w_j <= 10^6).
The roads connect all towns.
Each of the next `q` lines contains `u_k v_k t_k` (1 <= u_k, v_k <= n, 1 <= t_k <= 10^6).

## Output
Print `q` lines: the score after each new road.
