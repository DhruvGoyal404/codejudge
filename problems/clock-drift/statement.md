# Clock Drift

The clock in a railway station shows the time of day as `HH:MM:SS` on a 24-hour dial.
During the night the maintenance crew adjusts it `n` times; adjustment `i` moves the clock
by `d_i` seconds — forwards if `d_i` is positive, backwards if it is negative. The dial
wraps around: one second after `23:59:59` it shows `00:00:00`, and one second before
`00:00:00` it shows `23:59:59`.

Given the time shown before the first adjustment, print the time shown after the last one.

## Input
The first line contains the starting time as `HH:MM:SS` (00 <= HH <= 23, 00 <= MM, SS <= 59).
The second line contains `n` (1 <= n <= 200 000).
The third line contains `n` integers `d_1 ... d_n` (-10^9 <= d_i <= 10^9).

## Output
Print the final time as `HH:MM:SS`, each field with two digits.
