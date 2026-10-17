# Critical Roads

A province has `n` towns and `m` two-way roads. Two roads may join the same pair of towns,
and a road may even loop from a town back to itself.

Planners want to know how fragile the network is. A road is **critical** if closing it
(and nothing else) leaves some pair of towns that were connected unable to reach each
other. A town is a **hub** if closing it, together with every road touching it, leaves some
pair of the remaining towns that were connected unable to reach each other.

Print the number of critical roads and the number of hubs.

## Input
The first line contains `n` and `m` (1 <= n <= 200 000, 0 <= m <= 300 000).
Each of the next `m` lines contains `u_j v_j` (1 <= u_j, v_j <= n).

## Output
Print two integers: the number of critical roads and the number of hubs.
