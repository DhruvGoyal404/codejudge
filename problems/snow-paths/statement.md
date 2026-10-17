# Snow Paths

A ski resort maps its slope as a grid of `R` rows and `C` columns; `.` is open snow and
`#` is a rock. A skier starts at the top-left cell and finishes at the bottom-right cell.
Going downhill, every move goes one cell right, one cell down, or one cell diagonally down
and to the right, and never onto a rock.

Count the different routes, modulo `1 000 000 007`.

## Input
The first line contains `R` and `C` (1 <= R, C <= 1000).
Each of the next `R` lines contains `C` characters, `.` or `#`. The top-left and the
bottom-right cells are open.

## Output
Print the number of routes modulo `1 000 000 007`.
