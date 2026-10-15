# Guild Alliances

In a trading city there are `n` merchant guilds numbered `1` to `n`; at first each guild
stands alone. Over time the city records `q` events of two kinds:

- `U a b` — guilds `a` and `b` sign a pact: from now on their whole alliances are one
  alliance.
- `Q a b` — someone asks whether guilds `a` and `b` currently belong to the same alliance.

Answer every question.

## Input
The first line contains `n` and `q` (1 <= n, q <= 200 000).
Each of the next `q` lines contains an event `U a b` or `Q a b` (1 <= a, b <= n).
There is at least one `Q` event.

## Output
For each `Q` event, in order, print `YES` or `NO` on its own line.

## Example
Input:
```
4 5
Q 1 2
U 1 2
U 3 2
Q 1 3
Q 1 4
```
Output:
```
NO
YES
NO
```
