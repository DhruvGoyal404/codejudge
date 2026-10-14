"""Regenerates problem tests in the PRIVATE problems repo: runs
<root>/<slug>/gen/gen.py to write tests/NN.in, then runs
<root>/<slug>/solutions/ref.py on each input to write tests/NN.out.

Usage:  python scripts/make-tests.py [--tests-root DIR] [slug ...]

DIR defaults to $CODEJUDGE_PROBLEMS_TESTS_DIR (a checkout of
codejudge-problems). Afterwards run scripts/sync-samples.py to refresh the
public samples/ copies, and judge-admin check to validate everything.

Outputs come from the Python reference; the integration tests then require the
C++ reference to get AC on the same tests, which cross-checks them.
"""
import argparse
import glob
import os
import subprocess
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--tests-root", default=os.environ.get("CODEJUDGE_PROBLEMS_TESTS_DIR"))
ap.add_argument("slugs", nargs="*")
args = ap.parse_args()
if not args.tests_root:
    sys.exit("set --tests-root or CODEJUDGE_PROBLEMS_TESTS_DIR (checkout of the private problems repo)")
root = os.path.abspath(args.tests_root)
slugs = args.slugs or sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, "gen")))
for slug in slugs:
    pdir = os.path.join(root, slug)
    tests = os.path.join(pdir, "tests")
    for old in glob.glob(os.path.join(tests, "*.in")) + glob.glob(os.path.join(tests, "*.out")):
        os.remove(old)
    subprocess.run([sys.executable, os.path.join(pdir, "gen", "gen.py")], check=True)
    ref = os.path.join(pdir, "solutions", "ref.py")
    for inp in sorted(glob.glob(os.path.join(tests, "*.in"))):
        with open(inp, "rb") as f:
            out = subprocess.run([sys.executable, ref], stdin=f, capture_output=True, check=True).stdout
        with open(inp[:-3] + ".out", "wb") as f:
            f.write(out.replace(b"\r\n", b"\n"))
    n = len(glob.glob(os.path.join(tests, "*.in")))
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(tests, "*")))
    print(f"{slug}: {n} tests, {size / 1e6:.1f} MB")
