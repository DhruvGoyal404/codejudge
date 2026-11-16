"""Evaluates Insights' complexity classifier on a labelled corpus.

The corpus lives in the PRIVATE problems repo: insights-eval/labels.json maps
each problem to its programs and their true time class:

    {"ledger-total": {
        "solutions/slow.cpp": {"class": "n^2", "kind": "clear"},
        "solutions/ref.cpp":  {"class": "n",   "kind": "fast"},
        "insights-eval/ledger-total/sum_twice.py": {"class": "n", "kind": "ambiguous", "note": "..."}}}

Paths are relative to the problem's directory, or to the repo root when they
start with insights-eval/. kind:
  clear      the class must be named (strict) or, at worst, hedged as a pair containing it
  ambiguous  growth that a ladder may not settle (e.g. a quadratic term that only
             overtakes a linear one near the limit); the right answers are
             unclear, or any claim containing the class

A "fast" report (the whole ladder ran too quickly for growth to show) is an
abstention, not an error: it is counted separately, and accuracy is computed
over the programs that were measurable.

Usage: python scripts/insights-eval.py [--tests-root DIR] [--out FILE.jsonl] [--reps N] [slug ...]
Prints accuracy, the precision of every claim made, and a confusion matrix.
"""
import argparse
import collections
import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# A program is "measurable" when its cost grew by at least this much between
# the smallest and the largest completed ladder size: a property of the program
# and the problem's limits, decided from raw times, not by the classifier.
MEASURABLE_MS = 100
CLASSES = ["1", "log n", "n", "n log n", "n^2", "n^3", "2^(n/2)", "2^n"]


def claim(reported):
    """The classes a report claims (empty for unclear/fast)."""
    return [] if reported in ("unclear", "fast") else reported.split(" or ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tests-root", default=os.environ.get("CODEJUDGE_PROBLEMS_TESTS_DIR"))
    ap.add_argument("--out")
    ap.add_argument("--reps", default="0")
    ap.add_argument("slugs", nargs="*")
    a = ap.parse_args()
    root = os.path.abspath(a.tests_root)
    with open(os.path.join(root, "insights-eval", "labels.json")) as f:
        labels = json.load(f)
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, "judge-run" + (".exe" if os.name == "nt" else ""))
        subprocess.run(["go", "build", "-o", exe, "./cmd/judge-run"], cwd=os.path.join(REPO, "runner"), check=True)
        for slug in a.slugs or sorted(labels):
            progs = labels[slug]
            paths = {os.path.join(root, p) if p.startswith("insights-eval/") else os.path.join(root, slug, p): p for p in progs}
            cmd = [exe, "insights", "--problem", os.path.join(REPO, "problems", slug), "--reps", a.reps]
            for full in paths:
                cmd += ["--src", full]
            r = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "CODEJUDGE_PROBLEMS_TESTS_DIR": root})
            if r.returncode != 0:
                sys.exit(f"{slug}: {r.stderr.strip()}")
            reports = [json.loads(line) for line in r.stdout.splitlines()]
            for full, rep in zip(paths, reports):
                lab = progs[paths[full]]
                rows.append({"slug": slug, "src": paths[full], "lang": os.path.splitext(full)[1][1:], "true": lab["class"],
                             "kind": lab["kind"], "got": rep["time"]["class"], "confidence": rep["time"].get("confidence", 0),
                             "reason": rep["time"].get("reason", ""), "stopped_by": rep.get("stopped_by", ""),
                             "status": rep["status"], "steps": [(s["n"], s["cpu_ms"], s["status"]) for s in rep["steps"] or []]})
                print(f"{slug:18} {paths[full]:44} true={lab['class']:8} got={rows[-1]['got']:14} ({lab['kind']})"
                      + (f" [{rep['status']}: {rep.get('reason', '')[:80]}]" if rep["status"] != "ok" else ""), flush=True)
    if a.out:
        with open(a.out, "w") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")

    def grew(r):
        ok = [c for _, c, st in r["steps"] if st == "OK"]
        return len(ok) >= 2 and max(ok) - min(ok) >= MEASURABLE_MS
    fast = [r for r in rows if r["got"] == "fast"]
    clear = [r for r in rows if r["kind"] == "clear" and grew(r)]
    every = [r for r in rows if r["kind"] == "clear"]
    # n and n log n are never told apart (by design, see fit.go): the pair is
    # the exact answer for both. Any other pair is a hedge.
    exact = lambda r: r["got"] == r["true"] or (r["true"] in ("n", "n log n") and r["got"] == "n or n log n")
    strict = sum(exact(r) for r in clear)
    lenient = sum(r["true"] in claim(r["got"]) for r in clear)
    claims = [r for r in rows if claim(r["got"])]
    right = sum(r["true"] in claim(r["got"]) for r in claims)
    amb = [r for r in rows if r["kind"] == "ambiguous" and r["got"] != "fast"]
    amb_ok = sum(r["got"] == "unclear" or r["true"] in claim(r["got"]) for r in amb)
    pct = lambda k, n: f"{k}/{n} ({100 * k / n:.1f}%)" if n else "n/a"
    print()
    print(f"programs: {len(rows)}")
    print(f"measurable clear cases (>= {MEASURABLE_MS} ms growth): {len(clear)} of {len(every)}")
    print(f"clear cases, exact class (n/n log n as one): {pct(strict, len(clear))}")
    print(f"clear cases, exact or hedged pair:   {pct(lenient, len(clear))}")
    print(f"precision of every claim made:       {pct(right, len(claims))}")
    print(f"ambiguous cases answered honestly:   {pct(amb_ok, len(amb))}")
    print(f"too fast to measure (abstained):     {pct(len(fast), len(rows))}")
    print(f"coverage: a claim on a clear case:   {pct(sum(bool(claim(r['got'])) for r in every), len(every))}")
    cols = CLASSES + ["pair", "fast", "unclear"]
    m = collections.Counter((r["true"], r["got"] if r["got"] in CLASSES + ["fast", "unclear"] else "pair") for r in rows)
    print("\nconfusion (rows: true class, columns: reported)")
    print(f"{'':8}" + "".join(f"{c:>8}" for c in cols))
    for t in CLASSES:
        if any(k[0] == t for k in m):
            print(f"{t:8}" + "".join(f"{m.get((t, c), 0):>8}" for c in cols))


if __name__ == "__main__":
    main()
