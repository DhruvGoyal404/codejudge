# Lantern Festival

For the lantern festival, `n` posts along the river walk are numbered `1` to `n`; each
post's brightness starts at `0`. Then `q` volunteer crews pass by. Crew `j` adjusts every
post from `l_j` to `r_j` (inclusive) by `v_j` units — a negative `v_j` means they dim the
lanterns.

Print the brightness of every post after all crews have finished.

## Input
The first line contains `n` and `q` (1 <= n, q <= 200 000).
Each of the next `q` lines contains `l_j r_j v_j` (1 <= l_j <= r_j <= n, -10^9 <= v_j <= 10^9).

## Output
Print `n` integers on one line separated by spaces: the final brightness of posts `1..n`.
