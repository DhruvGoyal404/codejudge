# Press Split

A printing house must print `n` chapters of a book in order; chapter `i` takes `a_i`
minutes on a press. It has `k` presses. Each press gets one block of consecutive chapters
(every press at least one chapter), and all presses work at the same time.

Split the chapters into exactly `k` consecutive blocks so that the busiest press — the
block with the largest total — finishes as early as possible. Print that largest total.

## Input
The first line contains `n` and `k` (1 <= k <= n <= 100 000).
The second line contains `n` integers `a_1 ... a_n` (1 <= a_i <= 10^9).

## Output
Print the smallest possible value of the largest block total.
