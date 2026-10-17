# Subset Tally

A courier has `n` parcels with weights `w_1 ... w_n` and a scooter that carries at most
`W`. Before every shift she wonders how many different loads she could take: how many
subsets of the parcels (the empty load included) weigh at most `W` in total? Parcels with
equal weights are still different parcels.

## Input
The first line contains `n` and `W` (1 <= n <= 36, 0 <= W <= 10^18).
The second line contains `n` integers `w_1 ... w_n` (1 <= w_i <= 10^16).

## Output
Print the number of subsets with total weight at most `W`.
