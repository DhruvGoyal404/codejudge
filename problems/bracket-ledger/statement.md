# Bracket Ledger

An old accounting ledger uses three kinds of brackets — `()`, `[]` and `{}` — to group
entries. A line is well formed when every opening bracket is closed by a bracket of the
same kind, and pairs nest properly (they never cross, as in `([)]`).

Check one line. Read it from left to right, keeping the currently open brackets. The
first error is the first closing bracket that does not match the most recently opened
bracket still open (or that arrives when nothing is open). If there is no such closing
bracket but some brackets are still open at the end, the error is at position `n + 1`.

## Input
One line with a string `s` of length `n` (1 <= n <= 1 000 000) made of the characters
`()[]{}`.

## Output
Print `YES` if the line is well formed. Otherwise print `NO` and the 1-based position of
the first error, separated by a space.
