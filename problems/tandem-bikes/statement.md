# Tandem Bikes

A cycling club rents out tandem bikes. A tandem carries two riders, and the frame is rated
for a combined weight of at most `K`. There are `n` riders with weights `a_1 ... a_n`.

How many pairs of different riders `i < j` could share a tandem, that is, have
`a_i + a_j <= K`?

## Input
The first line contains `n` and `K` (1 <= n <= 200 000, 1 <= K <= 2*10^9).
The second line contains `n` integers `a_1 ... a_n` (1 <= a_i <= 10^9).

## Output
Print the number of pairs.
