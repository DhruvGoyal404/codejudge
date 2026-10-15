# Echo Log

A network monitor records the id of every packet it sees, in order. A packet is an echo
if a packet with the same id was already recorded earlier.

Print the position (1-based) of the first echo in the log, or `-1` if every id in the log
is different.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers, the ids in order (1 <= id <= 10^9).

## Output
Print the position of the first echo, or `-1`.

## Example
Input:
```
6
7 3 9 3 7 1
```
Output:
```
4
```
