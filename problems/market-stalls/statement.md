# Market Stalls

A weekend market is held along a straight road. Each of the `n` traders rents a stretch
`[a_i, b_i)` of the road — every point `x` with `a_i <= x < b_i`, measured in metres from
the road's start. Stretches may overlap or touch.

The council wants to know how many metres of road are occupied by at least one trader,
and into how many separate occupied stretches the market falls. Two stretches that touch
(one ends exactly where the other begins) count as one continuous stretch.

## Input
The first line contains `n` (1 <= n <= 200 000).
Each of the next `n` lines contains `a_i b_i` (0 <= a_i < b_i <= 10^9).

## Output
Print two integers: the occupied length and the number of separate occupied stretches.

## Example
Input:
```
4
1 3
2 5
7 8
5 6
```
Output:
```
6 2
```
