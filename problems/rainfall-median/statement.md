# Rainfall Median

A weather station logged the rainfall anomaly of `n` days: `r_i` tenths of a millimetre
above (positive) or below (negative) the long-term average. The yearly report quotes the
median day.

Sort the values; if `n` is odd the median is the middle value, and if `n` is even it is
the smaller of the two middle values. Print it.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `r_1 ... r_n` (-10^9 <= r_i <= 10^9).

## Output
Print the median as defined above.

## Example
Input:
```
6
4 -1 7 3 3 10
```
Output:
```
3
```
