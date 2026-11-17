"""Builds (or, with --check, verifies) Insights size ladders in the PRIVATE problems repo.

For each <root>/<slug> that has gen/ladder.py (lib/cjladder.py):
  1. gen/ladder.py DIR writes DIR/NN.in and DIR/ladder.json (seeded per size).
  2. gen/validate.py must accept every input; all inputs together stay under
     MAX_LADDER_BYTES (the batch container gets each input REPS times).
  3. The ladder goes to <slug>/ladder/, then solutions/ref.py (else ref.cpp)
     runs on it (judge-run insights) and its measured time class is recorded
     in ladder.json as the problem's reference.

--check rebuilds the inputs in a temporary directory and requires the
committed ladder/ inputs and steps to match (the reference class is a
measurement, so it is not compared).

--skip-reference generates and validates without Docker; the reference is
recorded later (a run without the flag, e.g. in CI).

Usage:  python scripts/make-ladders.py [--tests-root DIR] [--check | --skip-reference] [slug ...]
"""
import argparse
import filecmp
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

MAX_LADDER_BYTES = 20 << 20  # x 3 reps stays under the batch's 64 MB input cap
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class LadderError(Exception):
    pass


def build_judge_run(tmp):
    exe = os.path.join(tmp, "judge-run" + (".exe" if os.name == "nt" else ""))
    subprocess.run(["go", "build", "-o", exe, "./cmd/judge-run"], cwd=os.path.join(REPO, "runner"), check=True)
    return exe


def generate(slug, pdir, out):
    subprocess.run([sys.executable, os.path.join(pdir, "gen", "ladder.py"), out], check=True)
    ins = sorted(glob.glob(os.path.join(out, "*.in")))
    validator = os.path.join(pdir, "gen", "validate.py")
    for inp in ins:
        with open(inp, "rb") as f:
            r = subprocess.run([sys.executable, validator], stdin=f, capture_output=True, text=True)
        if r.returncode != 0:
            raise LadderError(f"{slug}: validator rejects ladder {os.path.basename(inp)}: {r.stderr.strip() or r.stdout.strip()}")
    total = sum(os.path.getsize(p) for p in ins)
    if total > MAX_LADDER_BYTES:
        raise LadderError(f"{slug}: ladder is {total} bytes, over {MAX_LADDER_BYTES}")
    return ins


def reference(slug, judge_run, root):
    """The reference's measured class: ref.py first (slower, so its growth shows
    more often within the limits), else ref.cpp; a class beats fast/unclear."""
    first = None
    for lang, name in (("python", "ref.py"), ("cpp", "ref.cpp")):
        src = os.path.join(root, slug, "solutions", name)
        if not os.path.exists(src):
            continue
        r = subprocess.run([judge_run, "insights", "--problem", os.path.join(REPO, "problems", slug), "--src", src],
                           capture_output=True, text=True, env={**os.environ, "CODEJUDGE_PROBLEMS_TESTS_DIR": root})
        if r.returncode != 0:
            raise LadderError(f"{slug}: {name} on the ladder: {r.stderr.strip()}")
        rep = json.loads(r.stdout.splitlines()[0])
        if rep["status"] != "ok" or rep.get("stopped_by"):
            raise LadderError(f"{slug}: {name} did not finish the ladder: {rep['status']} {rep.get('stopped_by', '')}")
        ref = {"lang": lang, "class": rep["time"]["class"]}
        if ref["class"] not in ("fast", "unclear"):
            return ref
        first = first or ref
    return first


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tests-root", default=os.environ.get("CODEJUDGE_PROBLEMS_TESTS_DIR"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--skip-reference", action="store_true")
    ap.add_argument("slugs", nargs="*")
    a = ap.parse_args()
    if not a.tests_root:
        sys.exit("--tests-root or $CODEJUDGE_PROBLEMS_TESTS_DIR is required")
    root = os.path.abspath(a.tests_root)
    slugs = a.slugs or sorted(os.path.basename(os.path.dirname(os.path.dirname(p)))
                              for p in glob.glob(os.path.join(root, "*", "gen", "ladder.py")))
    if a.check and not a.slugs:  # check what is committed; a new generator has nothing to compare yet
        slugs = [s for s in slugs if os.path.exists(os.path.join(root, s, "ladder", "ladder.json"))]
    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        judge_run = None if a.check or a.skip_reference else build_judge_run(tmp)
        for slug in slugs:
            try:
                one(slug, root, tmp, judge_run, a)
            except (LadderError, subprocess.CalledProcessError, OSError, ValueError) as e:
                print(f"{slug}: FAILED: {e}", flush=True)
                failed.append(slug)
    if failed:
        sys.exit(f"{len(failed)} of {len(slugs)} ladders failed: {' '.join(failed)}")


def one(slug, root, tmp, judge_run, a):
    pdir = os.path.join(root, slug)
    work = os.path.join(tmp, slug)
    ins = generate(slug, pdir, work)
    dest = os.path.join(pdir, "ladder")
    if a.check:
        with open(os.path.join(dest, "ladder.json")) as f:
            committed = json.load(f)
        with open(os.path.join(work, "ladder.json")) as f:
            fresh = json.load(f)
        committed.pop("reference", None)
        same = committed == fresh and all(
            filecmp.cmp(p, os.path.join(dest, os.path.basename(p)), shallow=False) for p in ins)
        if not same or len(glob.glob(os.path.join(dest, "*.in"))) != len(ins):
            raise LadderError("committed ladder/ differs from what gen/ladder.py produces")
        print(f"{slug}: ladder ok ({len(ins)} sizes)", flush=True)
        return
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(work, dest)
    if a.skip_reference:
        print(f"{slug}: {len(ins)} sizes (reference not measured)", flush=True)
        return
    ref = reference(slug, judge_run, root)
    path = os.path.join(dest, "ladder.json")
    with open(path) as f:
        lad = json.load(f)
    lad["reference"] = ref
    with open(path, "w", newline="\n") as f:
        json.dump(lad, f, indent=2)
        f.write("\n")
    print(f"{slug}: {len(ins)} sizes, reference {ref['lang']} = {ref['class']}", flush=True)

if __name__ == "__main__":
    main()
