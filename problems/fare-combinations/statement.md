# Fare Combinations

A tram ticket machine accepts coins of `n` different values `c_1 ... c_n`, and a rider
has as many coins of each value as needed. Paying the same multiset of coins in a
different order counts as the same payment.

Count the different ways to pay exactly `A`, modulo `1 000 000 007`.

## Input
The first line contains `n` and `A` (1 <= n <= 50, 1 <= A <= 50 000).
The second line contains `n` distinct integers `c_1 ... c_n` (1 <= c_i <= 50 000).

## Output
Print the number of ways to pay exactly `A`, modulo `1 000 000 007`.

## Example
Input:
```
3 5
1 2 5
```
Output:
```
4
```
