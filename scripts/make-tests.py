"""Builds (or, with --check, verifies) problem tests in the PRIVATE problems repo.

For each <root>/<slug>:
  1. gen/gen.py DIR writes DIR/NN.in (seeded: the same files on every run).
  2. gen/validate.py reads each input on stdin and exits non-zero if it breaks
     the statement's constraints.
  3. solutions/ref.cpp and solutions/ref.py run on every input in the real
     sandbox (judge-run outputs); their outputs must be byte-identical, and
     become tests/NN.out.
  4. Bounds: CATALOG_MIN_TESTS..MAX_TESTS tests, at most MAX_TOTAL_BYTES.

--check does all of it in a temporary directory and also requires the
committed tests/ to be exactly what the pipeline produces (CI runs this).

Usage:  python scripts/make-tests.py [--tests-root DIR] [--check] [slug ...]

DIR defaults to $CODEJUDGE_PROBLEMS_TESTS_DIR (a checkout of
codejudge-problems). Needs Docker and the sandbox images
(scripts/build-images.ps1). Afterwards run scripts/sync-samples.py to refresh
the public samples/ copies, and judge-admin check to validate everything.
"""
import argparse
import filecmp
import glob
import os
import shutil
import subprocess
import sys
import tempfile

# Keep in sync with runner/internal/problem (CatalogMinTests, MaxTotalBytes)
# and runner/internal/sandbox (MaxTests).
CATALOG_MIN_TESTS = 45
MAX_TESTS = 50
MAX_TOTAL_BYTES = 32 << 20

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_judge_run(tmp):
    exe = os.path.join(tmp, "judge-run" + (".exe" if os.name == "nt" else ""))
    subprocess.run(["go", "build", "-o", exe, "./cmd/judge-run"], cwd=os.path.join(REPO, "runner"), check=True)
    return exe


def outputs(judge_run, lang, src, inputs, out):
    r = subprocess.run([judge_run, "outputs", "--lang", lang, "--src", src, "--inputs", inputs, "--out", out],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"{os.path.basename(src)}: {r.stderr.strip()}")
    return r.stdout.strip()


def build(slug, pdir, judge_run, work):
    """Runs the pipeline for one problem into work/tests; returns a summary."""
    tests = os.path.join(work, "tests")
    os.makedirs(tests)
    # gen.py writes into the directory given as its argument (lib/cjgen.py).
    subprocess.run([sys.executable, os.path.join(pdir, "gen", "gen.py"), tests], check=True)
    ins = sorted(glob.glob(os.path.join(tests, "*.in")))
    if not CATALOG_MIN_TESTS <= len(ins) <= MAX_TESTS:
        sys.exit(f"{slug}: {len(ins)} tests, need {CATALOG_MIN_TESTS}..{MAX_TESTS}")

    validator = os.path.join(pdir, "gen", "validate.py")
    for inp in ins:
        with open(inp, "rb") as f:
            r = subprocess.run([sys.executable, validator], stdin=f, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"{slug}: validator rejects {os.path.basename(inp)}: {r.stderr.strip() or r.stdout.strip()}")

    sol = os.path.join(pdir, "solutions")
    py_out, cpp_out = os.path.join(work, "py"), os.path.join(work, "cpp")
    py = outputs(judge_run, "python", os.path.join(sol, "ref.py"), tests, py_out)
    cpp = outputs(judge_run, "cpp", os.path.join(sol, "ref.cpp"), tests, cpp_out)
    for inp in ins:
        name = os.path.basename(inp)[:-3] + ".out"
        a, b = os.path.join(py_out, name), os.path.join(cpp_out, name)
        if not filecmp.cmp(a, b, shallow=False):
            sys.exit(f"{slug}: ref.py and ref.cpp disagree on {name}")
        shutil.copyfile(a, os.path.join(tests, name))

    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(tests, "*")))
    if size > MAX_TOTAL_BYTES:
        sys.exit(f"{slug}: tests total {size} bytes > {MAX_TOTAL_BYTES}")
    return f"{len(ins)} tests, {size / 1e6:.1f} MB, validator ok, refs identical (py: {py}; cpp: {cpp})"


def same_tree(a, b):
    names_a = sorted(os.listdir(a))
    if names_a != sorted(os.listdir(b)):
        return False
    return all(filecmp.cmp(os.path.join(a, n), os.path.join(b, n), shallow=False) for n in names_a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tests-root", default=os.environ.get("CODEJUDGE_PROBLEMS_TESTS_DIR"))
    ap.add_argument("--check", action="store_true", help="verify the committed tests instead of writing them")
    ap.add_argument("slugs", nargs="*")
    args = ap.parse_args()
    if not args.tests_root:
        sys.exit("set --tests-root or CODEJUDGE_PROBLEMS_TESTS_DIR (checkout of the private problems repo)")
    root = os.path.abspath(args.tests_root)
    slugs = args.slugs or sorted(d for d in os.listdir(root) if os.path.isfile(os.path.join(root, d, "gen", "gen.py")))

    with tempfile.TemporaryDirectory() as tmp:
        judge_run = build_judge_run(tmp)
        for slug in slugs:
            pdir = os.path.join(root, slug)
            work = os.path.join(tmp, slug)
            summary = build(slug, pdir, judge_run, work)
            target = os.path.join(pdir, "tests")
            if args.check:
                if not os.path.isdir(target) or not same_tree(target, os.path.join(work, "tests")):
                    sys.exit(f"{slug}: committed tests/ differ from what the pipeline produces (rerun without --check)")
                print(f"{slug}: up to date; {summary}")
            else:
                shutil.rmtree(target, ignore_errors=True)
                shutil.copytree(os.path.join(work, "tests"), target)
                print(f"{slug}: {summary}")


if __name__ == "__main__":
    main()
