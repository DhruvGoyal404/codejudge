# Network Backbone

An internet provider wants to connect `n` towns with fibre. It has surveyed `m` possible
cables; cable `j` would join towns `u_j` and `v_j` and costs `w_j`. Cables carry data in
both directions, and data may pass through other towns.

Choose cables so that every pair of towns is connected, at the smallest total cost. Print
that cost, or `IMPOSSIBLE` if the towns cannot all be connected.

## Input
The first line contains `n` and `m` (1 <= n <= 200 000, 0 <= m <= 300 000).
Each of the next `m` lines contains `u_j v_j w_j` (1 <= u_j, v_j <= n, 1 <= w_j <= 10^9).

## Output
Print the minimum total cost, or `IMPOSSIBLE`.
