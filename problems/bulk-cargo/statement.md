# Bulk Cargo

A freight wagon can carry at most `W` tonnes. A wholesaler offers `n` kinds of goods: a
crate of kind `i` weighs `w_i` tonnes, earns `v_i` coins, and there are `c_i` crates of
that kind in stock.

Choose how many crates of each kind to load (from `0` to `c_i`) so that the total weight
is at most `W`. Print the largest possible earnings.

## Input
The first line contains `n` and `W` (1 <= n <= 50, 1 <= W <= 20 000).
Each of the next `n` lines contains `w_i v_i c_i` (1 <= w_i <= 20 000, 1 <= v_i <= 10^9, 1 <= c_i <= 10 000).

## Output
Print the largest earnings.
