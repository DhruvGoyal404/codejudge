import { describe, expect, it } from "vitest";

import { parseTrace, show, snapshots } from "./trace.ts";

const ok = {
  steps: [
    { l: 1, f: "<module>", d: {} },
    { l: 2, f: "<module>", d: { a: { t: "list", v: [3, 1, 2], n: 3 }, i: 0 } },
    { l: 3, f: "<module>", d: { i: 1 } },
  ],
  stdout: "6\n",
  capped: null,
  error: null,
};

describe("parseTrace (untrusted program output)", () => {
  it("accepts the tracer's shape and rebuilds each step's variables", () => {
    const t = parseTrace(JSON.stringify(ok))!;
    expect(t.steps).toHaveLength(3);
    expect(snapshots(t)[2]).toEqual({ a: { t: "list", v: [3, 1, 2], n: 3 }, i: 1 });
    expect(show(snapshots(t)[2]!.a!)).toBe("[3, 1, 2]");
  });

  it("rejects anything else", () => {
    expect(parseTrace("not json")).toBeNull();
    expect(parseTrace("[]")).toBeNull();
    expect(parseTrace(JSON.stringify({ ...ok, steps: [{ l: "1", f: "x", d: {} }] }))).toBeNull();
    expect(parseTrace(JSON.stringify({ ...ok, steps: [{ l: 1, f: "x", d: { a: { t: "evil", v: [], n: 0 } } }] }))).toBeNull();
    const deep = { t: "list", v: [{ t: "list", v: [{ t: "list", v: [{ t: "list", v: [], n: 0 }], n: 1 }], n: 1 }], n: 1 };
    expect(parseTrace(JSON.stringify({ ...ok, steps: [{ l: 1, f: "x", d: { a: deep } }] }))).toBeNull();
    expect(parseTrace(JSON.stringify({ ...ok, steps: Array.from({ length: 1001 }, () => ok.steps[0]) }))).toBeNull();
    expect(parseTrace("x".repeat((1 << 20) + 1))).toBeNull();
  });

  it("shows Python values, noting what was cut", () => {
    expect(show({ t: "dict", v: [["k", true]], n: 3 })).toBe('{"k": True, … 2 more}');
    expect(show(null)).toBe("None");
  });
});
