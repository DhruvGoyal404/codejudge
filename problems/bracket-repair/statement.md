# Bracket Repair

A typesetter received a damaged formula: a string of the brackets `()[]{}`. It must be
made well formed by **inserting** brackets anywhere (nothing can be removed). A string is
well formed if it is empty, or a well-formed string wrapped in a matching pair (`(...)`,
`[...]` or `{...}`), or two well-formed strings one after the other.

Print the least number of brackets to insert.

## Input
One line with the string `s` (1 <= |s| <= 200) of the characters `()[]{}`.

## Output
Print the minimum number of insertions.
