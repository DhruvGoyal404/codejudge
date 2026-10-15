# Tide Gauge

A harbour gauge records the water level once per hour. Over one season it stored `n`
readings `h_1 ... h_n` (in millimetres, relative to a fixed mark, so they may be negative).

The harbour master wants the sharpest hourly rise: the largest value of `h_{i+1} - h_i`
over all consecutive pairs. If the water never rose between two consecutive readings (or
there is only one reading), the answer is `0`.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `h_1 ... h_n` (-10^9 <= h_i <= 10^9).

## Output
Print the largest hourly rise, or `0` if there is none.

## Example
Input:
```
6
3 5 4 9 9 2
```
Output:
```
5
```
