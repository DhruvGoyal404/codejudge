# Courier Grid

A courier stands in a warehouse drawn as a grid of `R` rows and `C` columns. Every cell
is either free (`.`) or blocked by shelving (`#`). The courier starts on the cell marked
`S` and must reach the cell marked `T`; both are free cells. In one move the courier steps
to a free cell that shares a side with the current one.

Find the smallest number of moves needed, or report that `T` cannot be reached.

## Input
The first line contains `R` and `C` (1 <= R, C <= 500, R * C >= 2).
Each of the next `R` lines contains `C` characters from `.`, `#`, `S`, `T`.
There is exactly one `S` and exactly one `T`.

## Output
Print the minimum number of moves, or `-1` if `T` is unreachable.

## Example
Input:
```
3 4
S..#
.#..
...T
```
Output:
```
5
```
