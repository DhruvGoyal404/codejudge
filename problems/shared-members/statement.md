# Shared Members

Two hiking clubs keep their member lists as strictly increasing sequences of member ids.
The clubs are planning a joint trip and want to know which people belong to both clubs.

Print how many ids appear in both lists, followed by those ids in increasing order.

## Input
The first line contains `n` and `m` (1 <= n, m <= 200 000).
The second line contains `n` strictly increasing integers (1 <= id <= 10^9): the first list.
The third line contains `m` strictly increasing integers (1 <= id <= 10^9): the second list.

## Output
On the first line print `k`, the number of common ids. If `k > 0`, print the `k` common
ids in increasing order on the second line, separated by spaces.
