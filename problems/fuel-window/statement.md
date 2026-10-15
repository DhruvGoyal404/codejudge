# Fuel Window

A pipeline delivered fuel to a depot over `n` consecutive hours; in hour `i` it delivered
`a_i` litres (always a positive amount). An inspector wants to find a short stretch of
consecutive hours during which at least `S` litres arrived in total.

Print the length of the shortest such stretch, or `0` if even all `n` hours together
delivered less than `S` litres.

## Input
The first line contains `n` and `S` (1 <= n <= 200 000, 1 <= S <= 10^18).
The second line contains `n` integers `a_1 ... a_n` (1 <= a_i <= 10^9).

## Output
Print the length of the shortest stretch of consecutive hours with total at least `S`,
or `0` if there is none.

## Example
Input:
```
6 9
2 3 1 6 4 3
```
Output:
```
2
```
