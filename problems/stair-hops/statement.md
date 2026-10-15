# Stair Hops

A climber stands at the bottom of a staircase (step `0`) and wants to reach the top step
`n`. Each hop moves the climber up exactly 1, 2 or 3 steps. Some steps are cracked and
must never be landed on; the top step is never cracked.

Count the number of different hop sequences that take the climber from step `0` to step
`n`. As the number can be huge, print it modulo `1 000 000 007`.

## Input
The first line contains `n` and `m` (1 <= n <= 500 000, 0 <= m <= n - 1): the top step and
the number of cracked steps.
If `m > 0`, the second line contains `m` distinct integers between `1` and `n - 1`: the
cracked steps, in any order. If `m = 0` there is no second line.

## Output
Print the number of hop sequences modulo `1 000 000 007`.
