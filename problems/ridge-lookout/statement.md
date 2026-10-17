# Ridge Lookout

A survey team measured the altitude of `n` points along a ridge trail, `h_1 ... h_n` from
the trailhead. Hikers plan sections of the trail and ask `q` questions: on the section from
point `l` to point `r`, how high is the highest point, and where is the first point of the
section that reaches that height?

## Input
The first line contains `n` and `q` (1 <= n, q <= 200 000).
The second line contains `n` integers `h_1 ... h_n` (-10^9 <= h_i <= 10^9).
Each of the next `q` lines contains `l r` (1 <= l <= r <= n).

## Output
Print `q` lines: the highest altitude on the section and the first position where it
occurs, separated by a space.
