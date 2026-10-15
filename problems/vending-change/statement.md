# Vending Change

A ticket machine pays out change in coins worth 1, 2, 5, 10, 20, 50, 100, 200 and 500
units, and has an unlimited supply of each. For every amount, it wants to use as few
coins as possible.

For each of `q` amounts, print the smallest number of coins that add up to exactly that
amount.

## Input
The first line contains `q` (1 <= q <= 100 000).
Each of the next `q` lines contains one amount `A` (0 <= A <= 10^18).

## Output
Print `q` lines: the minimum number of coins for each amount.

## Example
Input:
```
3
13
0
999
```
Output:
```
3
0
8
```
