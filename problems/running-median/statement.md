# Running Median

A sensor streams `n` readings one by one. After each new reading, the dashboard shows the
median of all readings received so far: with `k` readings sorted, that is the reading in
position `ceil(k / 2)` — the middle one when `k` is odd and the smaller middle one when
`k` is even.

Print the value shown after every reading.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `x_1 ... x_n` (-10^9 <= x_i <= 10^9).

## Output
Print `n` integers separated by spaces: the median after each reading.

## Example
Input:
```
5
5 2 8 1 9
```
Output:
```
5 2 5 2 5
```
