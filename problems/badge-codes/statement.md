# Badge Codes

At the entrance of a conference, a scanner logs the code printed on every badge it reads.
A badge can be scanned many times. Codes consist of lowercase letters and digits.

From the log, report how many different badges were scanned, and which code was scanned
most often. If several codes share the highest count, report the lexicographically
smallest of them (compare character codes, so digits come before letters).

## Input
The first line contains `n` (1 <= n <= 200 000), the number of scans.
Each of the next `n` lines contains one code of 1 to 20 characters from `a-z` and `0-9`.

## Output
On the first line print the number of distinct codes.
On the second line print the most frequent code and its count, separated by a space.
