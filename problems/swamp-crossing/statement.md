# Swamp Crossing

A ranger crosses a marsh drawn as a grid of `R` rows and `C` columns. Each cell is dry
ground `.`, swamp `~` or rock `#`. The ranger starts on cell `S` and must reach cell `T`
(both dry), moving one cell up, down, left or right at a time; rock cannot be entered.

Wading into a swamp cell soaks the boots once more; walking onto dry ground costs nothing.
Print the smallest number of swamp cells the ranger has to enter, or `-1` if `T` cannot be
reached.

## Input
The first line contains `R` and `C` (1 <= R, C <= 500, R * C >= 2).
Each of the next `R` lines contains `C` characters from `.`, `~`, `#`, `S`, `T`; there is
exactly one `S` and exactly one `T`.

## Output
Print the minimum number of swamp cells entered, or `-1`.
