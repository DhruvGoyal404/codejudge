# Motif Search

A geneticist scans a long DNA-like strand `t` for a motif `p`. Both are strings of
lowercase letters. An occurrence is a position where `p` appears in `t` letter for
letter; occurrences may overlap.

Print how many times `p` occurs in `t`, and the 1-based position where the first
occurrence starts (`-1` if there is none).

## Input
The first line contains the strand `t` (1 <= |t| <= 200 000).
The second line contains the motif `p` (1 <= |p| <= 200 000).

## Output
Print the number of occurrences and the first position, separated by a space.
