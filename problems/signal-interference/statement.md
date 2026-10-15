# Signal Interference

`n` transmitters each broadcast on a channel given by a non-negative integer code. Two
transmitters interfere with a strength equal to the bitwise XOR of their codes.

Find the strongest interference between two different transmitters: the largest value of
`c_i XOR c_j` over all pairs `i < j`.

## Input
The first line contains `n` (2 <= n <= 100 000).
The second line contains `n` integers `c_1 ... c_n` (0 <= c_i < 2^30).

## Output
Print the largest XOR of two different codes.
