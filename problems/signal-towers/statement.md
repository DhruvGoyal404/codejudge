# Signal Towers

`n` signal towers stand along a ridge, numbered `1` to `n`; tower `i` currently reports a
noise level `a_i`. Engineers send `q` commands of two kinds:

- `1 i x` — tower `i` is recalibrated; its noise level becomes `x`.
- `2 l r` — report the quietest level among towers `l..r` (inclusive) and how many of
  those towers report exactly that level.

Answer every report command.

## Input
The first line contains `n` and `q` (1 <= n, q <= 100 000).
The second line contains `n` integers `a_1 ... a_n` (-10^9 <= a_i <= 10^9).
Each of the next `q` lines contains a command `1 i x` (1 <= i <= n, -10^9 <= x <= 10^9)
or `2 l r` (1 <= l <= r <= n). There is at least one command of type `2`.

## Output
For each command of type `2`, print the minimum level and its number of occurrences in
the range, separated by a space.

## Example
Input:
```
5 4
3 1 4 1 5
2 1 5
1 2 7
2 1 5
2 3 3
```
Output:
```
1 2
1 1
4 1
```
