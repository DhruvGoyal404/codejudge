# Stepping Ledges

A cliff path is a row of `n` ledges, numbered `1` to `n`. Ledge `i` holds a marker worth
`s_i` points; some markers are penalties, worth a negative number of points. A climber
starts on ledge `1` and must finish on ledge `n`. From ledge `i` she may jump forward to
any of the ledges `i + 1, ..., i + k`.

She collects the markers of every ledge she lands on, including the first and the last.
Print the largest score she can finish with.

## Input
The first line contains `n` and `k` (1 <= k <= n <= 200 000).
The second line contains `n` integers `s_1 ... s_n` (-10^9 <= s_i <= 10^9).

## Output
Print the largest possible score.
