# Stone Duel

Two players share `n` piles of stones. They move alternately; a move takes exactly `s`
stones from one pile, where `s` is one of the `k` allowed amounts and the pile has at
least `s` stones. A player who cannot move loses. Both players play perfectly.

If the second player wins, print `SECOND`. Otherwise print `FIRST` and the number of
different winning first moves — pairs (pile, amount) after which the first player still
wins with perfect play.

## Input
The first line contains `n` and `k` (1 <= n <= 100 000, 1 <= k <= 10).
The second line contains `k` distinct allowed amounts (1 <= s <= 100).
The third line contains the `n` pile sizes (0 <= p_i <= 100 000).

## Output
Print `SECOND`, or `FIRST` and the number of winning first moves, separated by a space.

## Example
Input:
```
2 2
1 2
3 1
```
Output:
```
FIRST 2
```
