# Dock Crates

A dock crane stacks crates on a single pile. During a shift it receives `q` commands:

- `P x` — put a crate of weight `x` on top of the pile;
- `R` — remove the crate on top (if the pile is empty, nothing happens);
- `T` — report the weight of the crate on top;
- `H` — report the weight of the heaviest crate in the pile.

For `T` and `H` on an empty pile, report `EMPTY`.

## Input
The first line contains `q` (1 <= q <= 200 000).
Each of the next `q` lines contains one command: `P x` (1 <= x <= 10^9), `R`, `T` or `H`.
There is at least one `T` or `H` command.

## Output
For every `T` and `H` command, in order, print the reported weight or `EMPTY` on its own line.
