# Trail Markers

A forest has `n` campsites joined by `n - 1` trails so that every campsite can be reached
from every other one in exactly one way. Rangers place markers along routes and ask `q`
questions `u v k`: walking from campsite `u` to campsite `v` along the trails, which
campsite is the `k`-th one on the way? (`k = 0` is `u` itself.) If the route has fewer
than `k + 1` campsites, the answer is `-1`.

## Input
The first line contains `n` and `q` (1 <= n, q <= 100 000).
Each of the next `n - 1` lines contains `a b` (1 <= a, b <= n): a trail between campsites `a` and `b`.
Each of the next `q` lines contains `u v k` (1 <= u, v <= n, 0 <= k <= n).

## Output
Print `q` lines: the campsite, or `-1`.
