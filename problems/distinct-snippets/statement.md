# Distinct Snippets

A music app shows listeners short snippets of a track: every stretch of exactly `k`
consecutive notes. The track is written as a string `s` of lowercase letters, one per
note. Two snippets that consist of the same notes in the same order are the same
snippet, wherever they start.

Print the number of different snippets of length `k`.

## Input
The first line contains `k` (1 <= k <= |s|).
The second line contains `s` (1 <= |s| <= 200 000).

## Output
Print the number of distinct substrings of `s` of length `k`.
