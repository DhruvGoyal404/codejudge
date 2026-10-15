# Window Peaks

A seismograph stores `n` readings `a_1 ... a_n`. An analyst slides a window of `k`
consecutive readings from the start to the end of the record, one reading at a time, and
for every position of the window notes the largest reading inside it.

Print the `n - k + 1` noted values in order.

## Input
The first line contains `n` and `k` (1 <= k <= n <= 200 000).
The second line contains `n` integers `a_1 ... a_n` (-10^9 <= a_i <= 10^9).

## Output
Print `n - k + 1` integers separated by spaces: the maximum of each window.

## Example
Input:
```
7 3
1 3 -1 -3 5 3 6
```
Output:
```
3 3 5 5 6
```
