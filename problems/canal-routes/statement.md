# Canal Routes

A city's canals connect `n` docks numbered `1` to `n` so that between any two docks there
is exactly one route that does not repeat a canal (the canals form a tree). Canal `j`
joins docks `u_j` and `v_j` and takes `w_j` minutes to travel.

Answer `q` questions: how many minutes does the route from dock `x` to dock `y` take?

## Input
The first line contains `n` and `q` (1 <= n, q <= 200 000).
Each of the next `n - 1` lines contains `u_j v_j w_j` (1 <= u_j, v_j <= n, 1 <= w_j <= 10^9);
the canals form a tree.
Each of the next `q` lines contains `x y` (1 <= x, y <= n).

## Output
Print `q` lines: the travel time of each route.
