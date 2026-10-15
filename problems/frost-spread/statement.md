# Frost Spread

A cold snap hits a marsh drawn as a grid of `R` rows and `C` columns. Every cell is open
water (`.`), rock (`#`) or already frozen (`*`). Each minute, every water cell that shares
a side with a frozen cell freezes. Rock never freezes and frost cannot pass through it.

Print the number of minutes after which no open water is left, or `-1` if some water
will never freeze. If there is no water at all, the answer is `0`.

## Input
The first line contains `R` and `C` (1 <= R, C <= 600).
Each of the next `R` lines contains `C` characters from `.`, `#`, `*`.

## Output
Print the number of minutes, or `-1`.

## Example
Input:
```
3 4
*...
.##.
...#
```
Output:
```
5
```
