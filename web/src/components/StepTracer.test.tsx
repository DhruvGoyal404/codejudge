import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StepTracer } from "./StepTracer.tsx";

const source = "a = [3, 1, 2]\ni = 0\ni = 2\nprint(a[i])\n";
const trace = {
  steps: [
    { l: 1, f: "<module>", d: {} },
    { l: 2, f: "<module>", d: { a: { t: "list" as const, v: [3, 1, 2], n: 3 } } },
    { l: 3, f: "<module>", d: { i: 0 } },
    { l: 4, f: "<module>", d: { i: 2 } },
  ],
  stdout: "2\n",
  capped: "stopped after 1000 steps",
  error: null,
};

describe("StepTracer", () => {
  it("steps through lines, highlights the current one, and draws pointers into lists", () => {
    render(<StepTracer trace={trace} source={source} />);
    expect(screen.getByTestId("tracer-position")).toHaveTextContent("Step 1 of 4 · line 1");
    fireEvent.click(screen.getByRole("button", { name: /Step/ }));
    fireEvent.click(screen.getByRole("button", { name: /Step/ }));
    fireEvent.click(screen.getByRole("button", { name: /Step/ }));
    expect(screen.getByTestId("tracer-position")).toHaveTextContent("Step 4 of 4 · line 4");
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("print(a[i])");
    expect(screen.getByRole("list", { name: "a: [3, 1, 2]" })).toHaveTextContent("i"); // pointer under index 2
    expect(screen.getByRole("status")).toHaveTextContent("stopped after 1000 steps");
    expect(screen.getByText("2", { selector: "pre" })).toBeInTheDocument();
  });
});
