# Ledger Total

A shop keeps a ledger of the day's transactions. Deposits are positive amounts and
withdrawals are negative amounts. At closing time the owner wants the net change.

## Input
The first line contains an integer `n` (1 <= n <= 100 000), the number of transactions.
The second line contains `n` integers `a_1 ... a_n` (-10^9 <= a_i <= 10^9).

## Output
Print one integer: `a_1 + a_2 + ... + a_n`.

## Notes
The total may not fit in a 32-bit integer.
