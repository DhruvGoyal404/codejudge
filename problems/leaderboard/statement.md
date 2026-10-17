# Leaderboard

A quiz night ends with `n` players and their scores. The host prints a leaderboard: players
in order of score, highest first, and players with equal scores in alphabetical order of
their names.

Each player also gets a rank: one plus the number of players with a strictly higher score.
Players with equal scores share a rank, and the next rank skips accordingly (scores
`90, 80, 80, 70` get ranks `1, 2, 2, 4`).

## Input
The first line contains `n` (1 <= n <= 100 000).
Each of the next `n` lines contains a name and a score: the name is 1 to 10 lowercase
letters, all names are different, and `0 <= score <= 10^9`.

## Output
Print `n` lines in leaderboard order: rank, name and score, separated by spaces.
