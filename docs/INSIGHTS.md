# Insights: design

After a submission, its owner can click **Analyze my solution**. CodeJudge then
runs the program again on inputs of growing size, measures how its CPU time
and memory grow, and says which complexity class fits, how sure it is, and
what the problem's reference solution does. Every claim comes from
measurements; when the data doesn't support a claim, the answer is "unclear".

## M1: empirical complexity

**Size ladders.** The existing generators can't be reused: each `gen/gen.py` is
a hand-written list of specific tests, with no size parameter. So each problem
gets a new private file, `gen/ladder.py`:
- It declares `SIZES` (about 8 sizes, spread geometrically up to the
  statement's limits) and a `LABEL` (for example "n = number of items";
  multi-parameter inputs scale together, such as m = 2n).
- `python ladder.py N` prints one input of size N, from a fixed seed derived
  from the slug and N. The input aims for the worst case, not a random one.
- `scripts/make-ladders.py` generates the inputs into the private repo
  (`<slug>/ladder/`), checks each against `gen/validate.py`, and records the
  reference's curve in `<slug>/ladder/ladder.json`.
- Ladder inputs, outputs and stdout are never returned to users. Only the size
  N and the measured CPU and memory for each step are.

**Measuring.** The program runs in the same gVisor sandbox, with the same
limits and the same batch container as judging.
- **CPU time** comes from the program's own rusage (`wait4` in judge-exec),
  which is what verdicts use.
- **Memory** is the peak RSS, also as for verdicts.
- **Repetitions:** each size runs k = 3 times (5 at the smallest sizes), and
  the median is used.
- **Baseline:** startup is subtracted, using an empty program in the same
  language measured once per worker.
- **Stopping:** the ladder runs in ascending order and stops at the first run
  over the per-run cap (the problem's time limit), a crash, or the analysis
  budget (20 s of CPU).

**Fitting.**
- **Models:** 1, log n, n, n log n, n², n³ and 2ⁿ, each fitted as
  t = c·f(n) by least squares on log t. Every model has one free parameter,
  so the selection rule is the AIC with Akaike weights as the confidence.
- **Points used:** only points whose net time is at least 5 times the
  baseline's jitter. With fewer than 4 such points, the answer is "unclear".
- **Close calls:** when the top weight is below 0.8, the answer is
  "unclear", unless the two leading models are n and n log n. Then it says
  "n or n log n".
- **Why a TLE happened:** the fit is extrapolated to the problem's largest
  size, then compared with the time limit. For example: "at n = 2·10⁵ this
  predicts about 40 s, against a 1 s limit".

**Reference.** The reference solution's class is precomputed per problem. The
panel shows "your solution looks O(n²); the reference scales as O(n log n)".
It doesn't say "this problem needs O(n log n)": a measurement shows what is
enough, not a lower bound.

**Scale.**
- **Queue:** a new stream, `judge:insights`, consumed by the existing worker
  with concurrency 1, on the pattern of the `judge:runs` stream behind "Run
  code".
- **Priority:**
  - Between ladder steps, the analysis pauses while judge entries are pending
    or in progress, so judging always goes first. This also keeps judging out
    of the measurements.
  - Its containers run with lower CPU shares.
- **Cache:** results are stored in Postgres, keyed by problem, ladder hash,
  language and SHA-256 of the code.
- **Limits:** 3 analyses per minute and 20 per day per user, and only on the
  user's own submissions that were AC, TLE or MLE.
- **Targets:** p95 under 30 s on an idle host. The existing 30-submission
  load test must show no regression in judging p95 while analyses run.

## Threat model (new paths)

| Asset or risk | Path | Control |
|---|---|---|
| Hidden data | Ladder inputs live next to the hidden tests | Never returned. The API serves only N, CPU ms and RSS for each step. Ladder inputs are random rather than hidden tests, so leaking one through timing is worth little. That channel already exists in per-test CPU times. |
| Host CPU (DoS) | One request runs up to about 20 s of CPU | Owner-only, rate-limited, cached, total budget per analysis, concurrency 1, yields to judging |
| Sandbox escape | More runs of untrusted code | The same sandbox and invariants, with no new privileges or mounts. Only the CPU shares change, and only downwards. |
| Other users' code | The cache is keyed by code hash | A cache hit reveals only that someone analyzed byte-identical code on the same problem. Accepted. |
| Request forgery | New POST route | The existing Origin check, session and owner check |
| M2 similarity data | The similarity page | Owner/admin only, enforced server-side by a new `users.is_admin` set by SQL. It is never shown to other users and never states a verdict of copying. |
| M3 trace output | Untrusted JSON from the sandbox | Size-capped before parsing, schema-validated, rendered as text (never HTML) |

## Evals and thresholds

**M1 complexity.** A labelled corpus in the private repo
(`insights-eval/`) of brute, better and optimal solutions across the 6
languages, plus tricky ones: amortized, early exit, and input-dependent. Each
is labelled with its class or with *ambiguous*.
- **Gates:**
  - Accuracy of at least 90% on clear cases, with a confusion matrix.
  - At least 95% precision on confident claims (a wrong confident claim is
    worse than "unclear").
  - On ambiguous cases, the answer is "unclear" or a two-class answer.
- **Noise test:** the same corpus under a CPU-hog container on the same host.
  Accuracy may drop by at most 5 points.
- **Judging:** the 30-submission load test, run with and without a flood of
  analyses. Judging p95 may rise by at most 10%.

**M2 similarity.** Obfuscated copies (renaming, reordering, dead code,
reformatting, C↔C++) and true negatives (independent solutions to short
problems). Precision and recall are reported, and the threshold is chosen
from the data, favouring precision.

**M3 tracer.** Caps are enforced (steps, snapshot size, output). A capped trace
says so, and fuzzed programs can't break the UI.

## What I think is wrong in the plan

1. **"Use the existing generators":** this isn't possible, because they have
   no size parameter. A new `ladder.py` per problem is needed. Ladders ship
   first for a curated set of problems where input size drives cost, and
   other problems say "not available yet". A ladder isn't meaningful for O(1)
   or fixed-size problems.
2. **"CPU time from the cgroup":** that's the wrong source. One batch
   container runs many inputs, and under runsc the cgroup also counts
   gVisor's own CPU. Per-process rusage is precise and is what verdicts use.
3. **n vs n log n, and 1 vs log n:** over 2 to 3 decades of n, a log factor
   is a 1.5–2× effect, which is close to noise, especially for Java and
   JavaScript, whose JIT adds noise. Reporting "n or n log n" when the fit
   can't tell them apart is honest. The eval reports log-factor accuracy
   separately.
4. **2ⁿ:** this needs its own tiny ladder (n from about 10 to 25). Only
   problems with an exponential reference or slow solution get one.
5. **Memory growth for Java, JavaScript and Go:** their heaps grow in steps,
   driven by the garbage collector, so a memory class is reported only where
   the eval shows it's reliable (expected: C and C++). Other languages show
   peak memory only.
6. **Judging latency on one t3.small:** "its own worker pool" on the same 2
   vCPUs can't protect judging by itself. What protects it is yielding
   between steps while judging is busy, plus lower CPU shares. The load test
   proves it.
7. **tree-sitter (M2, M4):** the Go bindings need cgo, which the static runner
   build doesn't use. The likely choice is tree-sitter's WebAssembly build in
   the API, decided in M2.
