# River Stones

`n` stepping stones cross a river in a line, numbered `1` to `n`. A frog starts on stone
`1` and wants to reach stone `n`. From stone `i` it can jump forward to any stone from
`i + 1` up to `i + p_i`, where `p_i` is the stone's spring power (`p_i = 0` means the frog
cannot jump from it).

Print the minimum number of jumps to reach stone `n`, or `-1` if it is impossible.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `p_1 ... p_n` (0 <= p_i <= 200 000).

## Output
Print the minimum number of jumps, or `-1`.
