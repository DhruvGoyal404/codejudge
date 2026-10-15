# Grade Curve

After a national exam the board knows the scores `s_1 ... s_n` of all candidates. To set
the pass mark it tries `q` candidate thresholds; for each threshold `t` it needs the
number of candidates whose score is at least `t`.

## Input
The first line contains `n` and `q` (1 <= n, q <= 200 000).
The second line contains `n` integers `s_1 ... s_n` (0 <= s_i <= 10^9).
The third line contains `q` integers `t_1 ... t_q` (0 <= t_j <= 10^9).

## Output
Print `q` integers separated by spaces: for each threshold, the number of scores `>= t_j`.
