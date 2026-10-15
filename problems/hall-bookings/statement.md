# Hall Bookings

A conference centre received `n` bookings. Booking `i` occupies one hall during the
time interval `[s_i, e_i)`: from moment `s_i` up to, but not including, moment `e_i`. A
booking that ends at moment `x` and one that starts at `x` do not overlap.

Find the largest number of bookings in progress at the same moment, and the earliest
integer moment at which that many are in progress.

## Input
The first line contains `n` (1 <= n <= 200 000).
Each of the next `n` lines contains `s_i e_i` (0 <= s_i < e_i <= 10^9).

## Output
Print two integers: the maximum number of simultaneous bookings and the earliest moment
it is reached.
