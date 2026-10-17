# Summit Pass

A mountain map is a grid of `R` rows and `C` columns; cell `(i, j)` has altitude `h_ij`.
A trekker walks from the top-left cell to the bottom-right cell, one cell up, down, left
or right at a time. The **effort** of a route is its steepest step: the largest absolute
difference in altitude between two consecutive cells on it.

Print the smallest possible effort of a route.

## Input
The first line contains `R` and `C` (1 <= R, C <= 500).
Each of the next `R` lines contains `C` integers `h_ij` (0 <= h_ij <= 10^6).

## Output
Print the minimum effort (`0` if the grid is a single cell).
