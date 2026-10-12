# Farthest Beacons

Rescue beacons have been dropped on a flat plain. Beacon `i` sits at integer coordinates
`(x_i, y_i)`; several beacons may share a position. The radio relay must be able to
bridge the two beacons that are farthest apart.

Find the largest Euclidean distance between any two beacons.

## Input
The first line contains `n` (1 <= n <= 100 000).
Each of the next `n` lines contains two integers `x_i y_i` (-10^9 <= x_i, y_i <= 10^9).

## Output
Print the largest distance. Answers within an absolute error of 1e-6 or a relative
error of 1e-9 of the exact value are accepted. With a single beacon the answer is 0.

## Example
Input:
```
4
0 0
3 0
0 4
3 4
```
Output:
```
5.000000
```
