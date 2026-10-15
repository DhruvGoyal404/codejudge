# Rival Teams

A coach must split `n` players into a red team and a blue team. There are `m` pairs of
rivals, and two rivals must never be on the same team. Every player joins exactly one
team; a team may be empty.

If no valid split exists, print `NO`. Otherwise print `YES` and the largest possible
number of players on the red team.

## Input
The first line contains `n` and `m` (1 <= n <= 200 000, 0 <= m <= 200 000).
Each of the next `m` lines contains `a b` (1 <= a, b <= n, a != b): players `a` and `b` are rivals.

## Output
Print `NO`, or `YES` followed by the maximum size of the red team, separated by a space.

## Example
Input:
```
5 3
1 2
2 3
4 5
```
Output:
```
YES 3
```
