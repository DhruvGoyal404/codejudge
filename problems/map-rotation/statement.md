# Map Rotation

A navigator keeps a rectangular chart of `R` rows and `C` columns, each cell a lowercase
letter, `#` or `.`. The crew turns the chart a quarter turn clockwise `k` times.

Print the chart as it looks after all the turns.

## Input
The first line contains `R`, `C` and `k` (1 <= R, C <= 500, 0 <= k <= 10^9).
Each of the next `R` lines contains `C` characters from `a-z`, `#` and `.`.

## Output
Print the turned chart, one row per line.

## Example
Input:
```
2 3 1
abc
def
```
Output:
```
da
eb
fc
```
