# Cargo Hold

A small freighter can carry at most `W` kilograms. At the quay there are `n` crates; crate
`i` weighs `w_i` kilograms and its delivery earns `v_i` credits. Crates cannot be split,
and each crate can be loaded at most once.

Choose crates whose total weight does not exceed `W` so that the total earnings are as
large as possible, and print those earnings.

## Input
The first line contains `n` and `W` (1 <= n <= 100, 1 <= W <= 30 000).
Each of the next `n` lines contains `w_i v_i` (1 <= w_i <= 30 000, 1 <= v_i <= 10^9).

## Output
Print the maximum total earnings (`0` if no crate fits).

## Example
Input:
```
3 10
5 10
4 40
6 30
```
Output:
```
70
```
