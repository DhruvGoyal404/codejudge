"""Regenerates every seed problem's tests: runs problems/<slug>/gen/gen.py to
write tests/NN.in, then runs problems/<slug>/solutions/ref.py on each input to
write tests/NN.out.

Usage:  python scripts/make-tests.py [slug ...]

Outputs come from the Python reference; the integration tests then require the
C++ reference to get AC on the same tests, which cross-checks them.
"""
import glob
import os
import subprocess
import sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "problems")
slugs = sys.argv[1:] or sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
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
