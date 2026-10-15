# Relay Delays

A mountain rescue network has `n` radio stations. There are `m` one-way relay links; link
`j` forwards a message from station `u_j` to station `v_j` and delays it by `w_j`
microseconds. A message starts at station `1`.

For every station, print the smallest total delay with which the message can reach it,
or `-1` if it can never get there.

## Input
The first line contains `n` and `m` (1 <= n <= 200 000, 0 <= m <= 300 000).
Each of the next `m` lines contains `u_j v_j w_j` (1 <= u_j, v_j <= n, 0 <= w_j <= 10^9).

## Output
Print `n` integers separated by spaces: the smallest delay for stations `1..n` (station
`1` itself has delay `0`).

## Example
Input:
```
4 4
1 2 5
1 3 2
3 2 1
2 4 7
```
Output:
```
0 3 2 10
```
