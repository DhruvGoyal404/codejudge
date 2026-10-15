# Course Order

A university offers `n` courses numbered `1` to `n`. Some pairs `a b` are prerequisites:
course `a` must be taken before course `b`. A student takes the courses one at a time,
every course exactly once.

Among all orders that respect every prerequisite, print the lexicographically smallest
one (the order whose first course number is smallest, then whose second is smallest, and
so on). If no order respects all prerequisites, print `IMPOSSIBLE`.

## Input
The first line contains `n` and `m` (1 <= n <= 200 000, 0 <= m <= 200 000).
Each of the next `m` lines contains `a b` (1 <= a, b <= n, a != b). A pair may repeat.

## Output
Print the `n` course numbers of the order separated by spaces, or `IMPOSSIBLE`.

## Example
Input:
```
4 3
3 1
2 4
3 2
```
Output:
```
3 1 2 4
```
