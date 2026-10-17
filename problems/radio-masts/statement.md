# Radio Masts

`n` farmhouses stand along a straight road at integer positions `x_1 ... x_n` (several
may share a position). A telecom company will put up exactly `k` radio masts at integer
positions of its choice. Every mast has the same range `D`: a mast at position `p` serves
every farmhouse at a position from `p - D` to `p + D`.

Print the smallest integer range `D` for which `k` masts can serve every farmhouse.

## Input
The first line contains `n` and `k` (1 <= k <= n <= 200 000).
The second line contains `n` integers `x_1 ... x_n` (0 <= x_i <= 10^9).

## Output
Print the smallest range `D`.
