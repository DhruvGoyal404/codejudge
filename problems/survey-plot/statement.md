# Survey Plot

A land surveyor marks the boundary of a plot as a simple polygon (its sides do not touch
or cross except at consecutive corners). All `n` corners lie on integer grid points and
are given in order around the boundary (clockwise or counter-clockwise).

Saplings will be planted on every grid point strictly inside the plot. Print twice the
area of the plot, and the number of grid points strictly inside it.

## Input
The first line contains `n` (3 <= n <= 100 000).
Each of the next `n` lines contains `x_i y_i` (-10^9 <= x_i, y_i <= 10^9), the corners in
order around the boundary. The polygon is simple and has non-zero area.

## Output
Print two integers: twice the area, and the number of grid points strictly inside.

## Example
Input:
```
4
0 0
4 0
4 3
0 3
```
Output:
```
24 6
```
