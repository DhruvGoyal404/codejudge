# Elevator Log

A skyscraper's freight elevator logs every floor it stops at. Floors are numbered by
integers; negative numbers are basement levels. The elevator starts the day at floor
`f_0` and then stops at floors `f_1, f_2, ..., f_n` in that order.

Print the total number of floors it travelled (the sum of `|f_i - f_{i-1}|`) and the
highest floor it was at during the day (including the start).

## Input
The first line contains `f_0` and `n` (-10^9 <= f_0 <= 10^9, 1 <= n <= 200 000).
The second line contains `n` integers `f_1 ... f_n` (-10^9 <= f_i <= 10^9).

## Output
Print two integers: the total distance and the highest floor.
