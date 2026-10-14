"""Copies each problem's sample tests from the PRIVATE problems repo into the
public problems/<slug>/samples/ (byte for byte), so users see exactly what is
judged. Only the tests named in problem.yaml's samples: list are copied.

Usage:  python scripts/sync-samples.py [--tests-root DIR] [--check]

--check copies nothing and exits 1 if any public sample differs from, or is
missing next to, its hidden copy (CI). judge-admin check enforces the same.
"""
import argparse
import os
import re
import shutil
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--tests-root", default=os.environ.get("CODEJUDGE_PROBLEMS_TESTS_DIR"))
ap.add_argument("--check", action="store_true")
args = ap.parse_args()
if not args.tests_root:
    sys.exit("set --tests-root or CODEJUDGE_PROBLEMS_TESTS_DIR (checkout of the private problems repo)")

public = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "problems")
bad = 0
for slug in sorted(os.listdir(public)):
    yml = os.path.join(public, slug, "problem.yaml")
    if not os.path.isfile(yml):
        continue
    m = re.search(r"^samples:\s*\[([^\]]*)\]", open(yml, encoding="utf-8").read(), re.M)
    names = [s.strip().strip("'\"") for s in m.group(1).split(",")] if m else []
    out_dir = os.path.join(public, slug, "samples")
    for name in names:
        for ext in ("in", "out"):
            src = os.path.join(args.tests_root, slug, "tests", f"{name}.{ext}")
            dst = os.path.join(out_dir, f"{name}.{ext}")
            want = open(src, "rb").read()
            have = open(dst, "rb").read() if os.path.exists(dst) else None
            if args.check:
                if have != want:
                    print(f"MISMATCH {slug}/samples/{name}.{ext}")
                    bad += 1
            elif have != want:
                os.makedirs(out_dir, exist_ok=True)
                shutil.copyfile(src, dst)
                print(f"wrote {slug}/samples/{name}.{ext}")
print("samples match" if not bad else f"{bad} sample file(s) differ")
sys.exit(1 if bad else 0)
