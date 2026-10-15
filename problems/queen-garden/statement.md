# Queen Garden

A sculpture garden is an `n` by `n` grid. The curator wants to place `n` queen statues,
one in every row, so that no two statues share a column or a diagonal (as chess queens
would attack each other). Some cells hold fountains (`#`) and cannot take a statue;
statues still "see" across fountains, so a fountain does not block an attack.

Count the different ways to place the `n` statues.

## Input
The first line contains `n` (1 <= n <= 12).
Each of the next `n` lines contains `n` characters: `.` for a free cell, `#` for a fountain.

## Output
Print the number of valid placements.
