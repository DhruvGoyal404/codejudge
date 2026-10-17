# Hatchery Costs

A fish farm has `n` ponds along a canal, at distinct positions `x_1 < x_2 < ... < x_n`.
The farm splits the ponds into groups of consecutive ponds and builds one feeding station
per group. A group made of ponds `i..j` costs `K + (x_j - x_i)^2` coins: a fixed building
cost plus the square of the stretch of canal it serves.

Print the least total cost to serve every pond.

## Input
The first line contains `n` and `K` (1 <= n <= 200 000, 0 <= K <= 10^12).
The second line contains `n` integers `x_1 < ... < x_n` (0 <= x_i <= 10^6).

## Output
Print the minimum total cost.
