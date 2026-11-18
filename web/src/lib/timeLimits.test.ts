import { describe, expect, it } from "vitest";

import { limitsByLanguage } from "./timeLimits.ts";

describe("limitsByLanguage", () => {
  it("groups languages by their effective limit, smallest first", () => {
    expect(limitsByLanguage({ c: 1000, cpp: 1000, go: 2000, python: 2000, java: 2000, javascript: 2000 })).toBe("C/C++ 1 s · Go/Java/JS/Python 2 s");
    expect(limitsByLanguage({ cpp: 2000, c: 2000, python: 6000, java: 3000, javascript: 3000, go: 4000 })).toBe("C/C++ 2 s · Java/JS 3 s · Go 4 s · Python 6 s");
    expect(limitsByLanguage({ cpp: 1500, python: 3750 })).toBe("C++ 1.5 s · Python 3.75 s");
  });
  it("is null before the problem is re-imported", () => {
    expect(limitsByLanguage(null)).toBeNull();
    expect(limitsByLanguage({})).toBeNull();
  });
});
