# Echo Palindromes

A sound engineer stores a recording as a string `s` of lowercase letters, one per sample.
A stretch of consecutive samples is an **echo** if it reads the same forwards and
backwards. Every single sample is an echo by itself.

Count the echoes: the number of pairs `i <= j` such that `s_i ... s_j` is a palindrome.

## Input
One line with `s` (1 <= |s| <= 500 000).

## Output
Print the number of palindromic stretches.
