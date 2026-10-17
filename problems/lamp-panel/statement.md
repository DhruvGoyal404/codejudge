# Lamp Panel

A control panel shows a row of 63 lamps; reading the lamps as binary digits (the rightmost
lamp is bit `0`) gives a number `x`. For each reading, the technician needs three facts:

- how many lamps are lit (the number of 1 bits of `x`);
- the position of the rightmost lit lamp (the lowest 1 bit), or `-1` if none is lit;
- the reading after switching off the rightmost lit lamp (`x` itself if none is lit).

## Input
The first line contains `q` (1 <= q <= 100 000).
Each of the next `q` lines contains one reading `x` (0 <= x < 2^63).

## Output
Print `q` lines with the three values for each reading, separated by spaces.
