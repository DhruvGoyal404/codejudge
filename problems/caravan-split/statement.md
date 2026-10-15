# Caravan Split

A freight caravan is a single line of `n` wagons; wagon `i` weighs `w_i` tonnes. At the
junction the caravan is uncoupled exactly once, between two neighbouring wagons, and the
two parts continue as separate trains. Both parts must contain at least one wagon.

Choose the coupling to undo so that the two trains are as close in weight as possible,
and print the smallest possible absolute difference of their total weights.

## Input
The first line contains `n` (2 <= n <= 200 000).
The second line contains `n` integers `w_1 ... w_n` (1 <= w_i <= 10^9).

## Output
Print the minimum possible difference between the total weights of the two trains.

## Example
Input:
```
5
3 1 4 1 5
```
Output:
```
2
```
