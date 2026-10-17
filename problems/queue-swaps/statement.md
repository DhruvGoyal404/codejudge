# Queue Swaps

Visitors at a museum entrance stand in a single line, each holding a ticket with a number.
The guard wants the line ordered by ticket number, smallest first, and may only ask two
neighbours to swap places. Visitors with equal numbers never need to be swapped with each
other.

Print the smallest number of swaps of neighbours that puts the line in order.

## Input
The first line contains `n` (1 <= n <= 200 000).
The second line contains `n` integers `t_1 ... t_n` (1 <= t_i <= 10^9), the ticket numbers
from the front of the line to the back.

## Output
Print the minimum number of swaps.
