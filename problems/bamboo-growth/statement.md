# Bamboo Growth

A botanist models the number of shoots in a bamboo grove: in year `n` (for `n >= k`)
there are

`a_n = c_1 * a_{n-1} + c_2 * a_{n-2} + ... + c_k * a_{n-k}`

shoots, counted modulo `1 000 000 007`. The first `k` years `a_0 ... a_{k-1}` were
measured directly.

Answer `q` questions: how many shoots (modulo `1 000 000 007`) are there in year `n`?

## Input
The first line contains `k` and `q` (1 <= k <= 10, 1 <= q <= 200).
The second line contains `c_1 ... c_k` (0 <= c_i < 1 000 000 007).
The third line contains `a_0 ... a_{k-1}` (0 <= a_i < 1 000 000 007).
Each of the next `q` lines contains one year `n` (0 <= n <= 10^18).

## Output
Print `q` lines: `a_n` modulo `1 000 000 007` for each question.
