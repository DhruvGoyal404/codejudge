# Signal Hub

A radio network has `n` relay stations joined by `n - 1` cables so that every station can
reach every other one in exactly one way. Cable `j` joins stations `u_j` and `v_j` and has
length `w_j`. A signal sent from a station to another travels along the cables between
them.

The operator considers making each station the hub. For every station, print the total
cable length of the routes from it to all the other stations.

## Input
The first line contains `n` (1 <= n <= 200 000).
Each of the next `n - 1` lines contains `u_j v_j w_j` (1 <= u_j, v_j <= n, 1 <= w_j <= 10 000).

## Output
Print `n` integers separated by spaces: the total for stations `1 ... n`.
