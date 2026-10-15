# Digit Roots

A numerologist reduces a number by replacing it with the sum of its decimal digits,
again and again, until a single digit remains. For example `9875 -> 29 -> 11 -> 2`.

Given several numbers, print the single digit each one reduces to. The numbers can be
very long.

## Input
The first line contains `q` (1 <= q <= 100 000).
Each of the next `q` lines contains a non-negative integer without leading zeros (the
number `0` is written as `0`). The total number of digits is at most 1 000 000.

## Output
Print `q` lines, the resulting digit for each number.

## Example
Input:
```
3
9875
0
18
```
Output:
```
2
0
9
```
