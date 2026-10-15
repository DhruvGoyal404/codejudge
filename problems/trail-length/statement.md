# Trail Length

A national park has `n` camps connected by `n - 1` two-way trails so that every camp can
be reached from every other one in exactly one way without repeating a trail. Trail `j`
joins camps `u_j` and `v_j` and is `w_j` metres long.

The park wants to advertise its longest hike between two camps (along trails, never
repeating one). Print its length.

## Input
The first line contains `n` (1 <= n <= 200 000).
Each of the next `n - 1` lines contains `u_j v_j w_j` (1 <= u_j, v_j <= n, 1 <= w_j <= 10^9).
The trails form a tree.

## Output
Print the length of the longest hike (`0` if there is only one camp).

## Example
Input:
```
5
1 2 3
2 3 4
2 4 2
4 5 6
```
Output:
```
12
```
