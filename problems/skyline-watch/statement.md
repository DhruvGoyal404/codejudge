# Skyline Watch

`n` buildings stand in a row from west to east; building `i` has height `h_i`. A
watchman on the roof of each building looks east. His view is blocked by the first
building to the east that is strictly taller than his own.

For every building `i`, print the distance `j - i` to that first strictly taller
building `j > i`, or `0` if no building to the east is taller.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `h_1 ... h_n` (1 <= h_i <= 10^9).

## Output
Print `n` integers separated by spaces.
