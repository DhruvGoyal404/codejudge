# Rope Joining

A rigger has `n` ropes laid out in a row, with lengths `a_1 ... a_n`. She joins them into a
single rope by repeatedly splicing two **neighbouring** ropes into one; splicing ropes of
lengths `x` and `y` takes `x + y` minutes and leaves one rope of length `x + y` in their
place.

Print the least total time needed to end up with a single rope.

## Input
The first line contains `n` (1 <= n <= 200).
The second line contains `n` integers `a_1 ... a_n` (1 <= a_i <= 10^6).

## Output
Print the minimum total time.
