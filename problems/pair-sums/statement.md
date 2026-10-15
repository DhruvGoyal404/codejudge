# Pair Sums

A shop sells `n` items with prices `a_1 ... a_n` (adjustments make some prices negative).
A gift voucher is worth exactly `K`. How many pairs of different items `i < j` have prices
that add up to exactly `K`?

## Input
The first line contains `n` and `K` (1 <= n <= 200 000, -2*10^9 <= K <= 2*10^9).
The second line contains `n` integers `a_1 ... a_n` (-10^9 <= a_i <= 10^9).

## Output
Print the number of pairs.

## Example
Input:
```
5 6
1 5 3 3 7
```
Output:
```
2
```
