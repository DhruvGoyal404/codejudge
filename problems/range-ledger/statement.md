# Range Ledger

An archive stores `n` daily balances `b_1 ... b_n`. Auditors send `q` questions; each
question names two days `l` and `r` and asks for the sum of the balances from day `l`
to day `r`, both inclusive.

## Input
The first line contains `n` and `q` (1 <= n, q <= 100 000).
The second line contains `n` integers `b_1 ... b_n` (-10^9 <= b_i <= 10^9).
Each of the next `q` lines contains two integers `l r` (1 <= l <= r <= n).

## Output
For each question print the requested sum on its own line.

## Example
Input:
```
5 3
1 2 3 4 5
1 5
2 4
3 3
```
Output:
```
15
9
3
```
