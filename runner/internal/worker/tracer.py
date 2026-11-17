# Step tracer for Python programs (docs/INSIGHTS.md, M3). The worker appends
# the user's program as a string literal (USER_SOURCE) and runs this in the
# same sandbox, with the same limits, as any custom run. It prints ONE JSON
# document: {"steps": [...], "stdout": "...", "capped": "...", "error": "..."}.
# Each step is {"l": line, "d": {name: value}} with only the locals that
# changed since the previous step of the same frame (the replay rebuilds the
# rest). Hard caps keep the output small; "capped" says which one was hit.
import io
import json
import sys

MAX_STEPS = 1000
MAX_VARS = 40
MAX_ITEMS = 64
MAX_STR = 120
MAX_STDOUT = 16384

steps = []
capped = None
last = {}  # frame id -> {name: encoded value}


def enc(v, depth=0):
    """A JSON-safe, size-capped copy of a value, or None for what we skip."""
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if abs(v) < 2**53 else str(v)
    if isinstance(v, float):
        return v if v == v and abs(v) != float("inf") else str(v)
    if isinstance(v, str):
        return v if len(v) <= MAX_STR else v[:MAX_STR] + "..."
    if depth >= 2:
        return "..."
    if isinstance(v, (list, tuple)):
        items = [enc(x, depth + 1) for x in v[:MAX_ITEMS]]
        return {"t": "list" if isinstance(v, list) else "tuple", "v": items, "n": len(v)}
    if isinstance(v, (set, frozenset)):
        items = [enc(x, depth + 1) for x in sorted(v, key=repr)[:MAX_ITEMS]]
        return {"t": "set", "v": items, "n": len(v)}
    if isinstance(v, dict):
        items = [[enc(k, depth + 1), enc(x, depth + 1)] for k, x in list(v.items())[:MAX_ITEMS]]
        return {"t": "dict", "v": items, "n": len(v)}
    return None  # functions, modules, classes, files: not shown


def tracer(frame, event, arg):
    global capped
    if frame.f_code.co_filename != "<solution>":
        return tracer
    if event == "line":
        if len(steps) >= MAX_STEPS:
            capped = f"stopped after {MAX_STEPS} steps"
            sys.settrace(None)
            raise SystemExit(0)
        cur = {}
        for name, value in list(frame.f_locals.items())[:MAX_VARS]:
            if name.startswith("__"):
                continue
            e = enc(value)
            if e is not None:
                cur[name] = e
        prev = last.get(id(frame), {})
        diff = {k: v for k, v in cur.items() if prev.get(k, object()) != v}
        last[id(frame)] = cur
        steps.append({"l": frame.f_lineno, "f": frame.f_code.co_name, "d": diff})
    return tracer


out = io.StringIO()
real_stdout = sys.stdout
error = None
sys.stdout = out
try:
    code = compile(USER_SOURCE, "<solution>", "exec")  # noqa: F821 (appended by the worker)
    sys.settrace(tracer)
    exec(code, {"__name__": "__main__"})
except SystemExit:
    pass
except BaseException as e:  # the program's own error is part of the trace
    error = f"{type(e).__name__}: {e}"[:300]
finally:
    sys.settrace(None)
    sys.stdout = real_stdout
stdout = out.getvalue()
if len(stdout) > MAX_STDOUT:
    stdout = stdout[:MAX_STDOUT]
    capped = capped or "output truncated"
real_stdout.write(json.dumps({"steps": steps, "stdout": stdout, "capped": capped, "error": error}, separators=(",", ":")))
