# Reef Islands

A survey drone photographed a lagoon and turned the picture into a grid of `R` rows and
`C` columns: `#` marks coral reef above the water and `.` marks open water. Two reef cells
belong to the same island when they share a side; diagonal contact does not count.

Report the number of islands and the number of cells in the largest one.

## Input
The first line contains `R` and `C` (1 <= R, C <= 800).
Each of the next `R` lines contains `C` characters, each `#` or `.`.

## Output
Print two integers: the number of islands and the size of the largest island. If there is
no reef at all, print `0 0`.

## Example
Input:
```
4 5
##..#
#...#
..#..
....#
```
Output:
```
4 3
```
