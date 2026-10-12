# Rising Towers

A street has `n` towers standing in a row, with heights `h_1 ... h_n` from west to east.
A photographer walking east wants to photograph as many towers as possible, but only
in strictly rising order: each photographed tower must be strictly taller than the one
photographed before it. Towers may be skipped.

How many towers can be photographed?

## Input
The first line contains `n` (1 <= n <= 100 000).
The second line contains `n` integers `h_1 ... h_n` (1 <= h_i <= 10^9).

## Output
Print the maximum number of towers.

## Example
Input:
```
8
3 1 4 1 5 9 2 6
```
Output:
```
4
```
