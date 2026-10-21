import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DESCRIPTION, useTitle } from "./useTitle.ts";

const meta = () => document.querySelector('meta[name="description"]')!.getAttribute("content");

describe("useTitle", () => {
  beforeEach(() => {
    const m = document.createElement("meta");
    m.name = "description";
    m.content = "from index.html";
    document.head.append(m);
  });
  afterEach(() => document.head.querySelector('meta[name="description"]')?.remove());

  it("sets the title and the default description", () => {
    renderHook(() => useTitle(null));
    expect(document.title).toBe("CodeJudge");
    expect(meta()).toBe(DEFAULT_DESCRIPTION);
  });

  it("sets a page's own title and description, and follows changes", () => {
    const { rerender } = renderHook(({ t, d }) => useTitle(t, d), { initialProps: { t: "Problems", d: "first" } });
    expect(document.title).toBe("Problems · CodeJudge");
    expect(meta()).toBe("first");
    rerender({ t: "Two Sum", d: "second" });
    expect(document.title).toBe("Two Sum · CodeJudge");
    expect(meta()).toBe("second");
  });
});
