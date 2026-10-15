# Tile Floors

A tiler covers rectangular floors with identical square tiles. A floor is `W` by `H`
units; tiles must not be cut, must have an integer side length, and must cover the floor
exactly. To save labour the tiler always uses the largest tile that works.

For each floor print the side of that tile and the number of tiles needed.

## Input
The first line contains `q` (1 <= q <= 100 000).
Each of the next `q` lines contains `W H` (1 <= W, H <= 10^18).

## Output
For each floor print the tile side and the number of tiles, separated by a space. The
number of tiles can exceed `2^64`.

## Example
Input:
```
2
12 18
7 5
```
Output:
```
6 6
1 35
```
