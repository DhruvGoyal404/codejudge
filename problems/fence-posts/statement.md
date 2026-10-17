# Fence Posts

A rancher marked `n` spots on a map with integer coordinates and wants one tight fence
around all of them: the smallest convex region that contains every spot. Fence posts go
only at the corners of that region; a spot lying on a straight stretch of fence between
two corners is not a corner.

Print the number of corner posts and twice the area enclosed by the fence. If all spots
lie on one line (or are all the same spot), the "fence" encloses no area; then print the
number of distinct end points of that line (`1` or `2`) and `0`.

## Input
The first line contains `n` (1 <= n <= 200 000).
Each of the next `n` lines contains `x_i y_i` (-10^9 <= x_i, y_i <= 10^9).

## Output
Print two integers: the number of corner posts and twice the enclosed area.
