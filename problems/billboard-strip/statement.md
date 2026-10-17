# Billboard Strip

A light strip on a stadium billboard has `n` panels, numbered `1` to `n`, all dark
(brightness `0`) at the start. The operator sends `q` commands:

- `1 l r x` — set the brightness of every panel `l..r` to `x`;
- `2 l r` — report the total brightness of panels `l..r`.

Answer every report command.

## Input
The first line contains `n` and `q` (1 <= n, q <= 100 000).
Each of the next `q` lines contains a command `1 l r x` (1 <= l <= r <= n, 0 <= x <= 10^9)
or `2 l r` (1 <= l <= r <= n). There is at least one command of type `2`.

## Output
For each command of type `2`, print the total brightness on its own line.
