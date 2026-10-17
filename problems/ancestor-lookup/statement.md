# Ancestor Lookup

A genealogy archive stores a family tree of `n` people, numbered `1` to `n`. Person `1` is
the founder; every other person `i` has exactly one recorded parent `p_i`, and following
parents from anyone always leads back to the founder.

Researchers send `q` questions `v k`: who is the ancestor of person `v`, `k` generations
up? (`k = 1` is the parent, `k = 2` the grandparent, and so on; `k = 0` is `v` itself.)
If the line ends before that, the answer is `-1`.

## Input
The first line contains `n` and `q` (1 <= n, q <= 200 000).
If `n > 1`, the second line contains `p_2 ... p_n` (1 <= p_i <= n).
Each of the next `q` lines contains `v k` (1 <= v <= n, 0 <= k <= n).

## Output
Print `q` lines: the ancestor, or `-1`.
