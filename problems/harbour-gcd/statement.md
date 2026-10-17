# Harbour GCD

A harbour master logs the cargo of `n` ships in arrival order: ship `i` carries `a_i`
crates. For a run of consecutive ships, the **pallet size** is the largest number that
divides every ship's crate count in the run (their greatest common divisor), so the
cargo can be repacked into equal pallets of that size.

Count the runs `l <= r` whose pallet size is exactly `g`.

## Input
The first line contains `n` and `g` (1 <= n <= 100 000, 1 <= g <= 10^9).
The second line contains `n` integers `a_1 ... a_n` (1 <= a_i <= 10^9).

## Output
Print the number of runs with pallet size exactly `g`.
