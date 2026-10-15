# Mirror Tags

A warehouse prints a tag for every crate. The new sorting robot reads tags from either
end, so every tag must read the same forwards and backwards. A printer can overwrite any
single character of a tag with any other lowercase letter; each overwrite costs one unit.

For every tag, print the minimum number of overwrites that make it read the same in both
directions.

## Input
The first line contains `q` (1 <= q <= 100 000), the number of tags.
Each of the next `q` lines contains one tag: a non-empty string of lowercase letters.
The total length of all tags is at most 1 000 000.

## Output
Print `q` lines; line `i` holds the answer for tag `i`.
