# Rail Fares

A regional railway has `n` stations and `m` one-way services; service `j` runs from
station `u_j` to station `v_j` and costs `w_j` coins. Travellers may change trains at any
station, paying for every service they ride.

The ticket office receives `q` questions: what is the cheapest fare from station `a` to
station `b`? A trip from a station to itself costs nothing.

## Input
The first line contains `n`, `m` and `q` (1 <= n <= 200, 0 <= m <= 40 000, 1 <= q <= 100 000).
Each of the next `m` lines contains `u_j v_j w_j` (1 <= u_j, v_j <= n, 1 <= w_j <= 10^6).
Each of the next `q` lines contains `a b` (1 <= a, b <= n).

## Output
Print `q` lines: the cheapest fare, or `-1` if `b` cannot be reached from `a`.
