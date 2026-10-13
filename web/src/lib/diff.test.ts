import { describe, expect, it } from "vitest";

import { lineDiff } from "./diff.ts";

const show = (e: string, a: string) =>
  lineDiff(e, a)
    .map((l) => (l.kind === "same" ? " " : l.kind === "expected" ? "-" : "+") + l.text)
    .join("|");

describe("lineDiff", () => {
  it("identical outputs are all 'same'", () => {
    expect(show("15\n9\n3\n", "15\n9\n3\n")).toBe(" 15| 9| 3");
  });

  it("marks changed lines as expected-only then actual-only", () => {
    expect(show("15\n9\n3\n", "14\n7\n0\n")).toBe("-15|-9|-3|+14|+7|+0");
    expect(show("15\n9\n3\n", "15\n8\n3\n")).toBe(" 15|-9|+8| 3");
  });

  it("handles missing and extra lines", () => {
    expect(show("1\n2\n3\n", "1\n3\n")).toBe(" 1|-2| 3");
    expect(show("1\n", "1\n2\n")).toBe(" 1|+2");
  });

  it("normalizes CRLF and trailing newlines like the judge", () => {
    expect(show("a\r\nb\r\n", "a\nb")).toBe(" a| b");
    expect(show("x\n\n\n", "x")).toBe(" x");
  });

  it("empty output vs expected", () => {
    expect(show("42\n", "")).toBe("-42");
    expect(lineDiff("", "")).toEqual([]);
  });
});
