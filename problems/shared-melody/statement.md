# Shared Melody

Two folk tunes are written as strings of lowercase letters, one letter per note. A
musicologist looks for the longest melody hidden in both tunes: a sequence of notes that
appears in each tune in the same order, though not necessarily consecutively (notes in
between may be skipped).

Print the length of the longest such shared melody.

## Input
The first line contains the first tune `a` (1 <= |a| <= 5000).
The second line contains the second tune `b` (1 <= |b| <= 5000).

## Output
Print the length of the longest melody that both tunes contain in order.

## Example
Input:
```
abcbdab
bdcaba
```
Output:
```
4
```
