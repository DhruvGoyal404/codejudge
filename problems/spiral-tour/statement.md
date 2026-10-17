# Spiral Tour

A museum hall is a grid of `R` rows and `C` columns of display cases; case `(i, j)` has
exhibit number `a_ij`. The audio guide leads visitors on a spiral tour: start at the
top-left case, walk right along the top row, then down the right column, left along the
bottom row, up the left column, and continue inwards in the same way, clockwise, until
every case has been visited exactly once.

Print the exhibit numbers in the order of the tour.

## Input
The first line contains `R` and `C` (1 <= R, C <= 500).
Each of the next `R` lines contains `C` integers `a_ij` (0 <= a_ij <= 10^6).

## Output
Print the `R * C` exhibit numbers in tour order, separated by spaces.
