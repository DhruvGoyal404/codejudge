import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MAX_RUN_INPUT_BYTES } from "../api.ts";
import { RunPanel } from "./RunPanel.tsx";

const samples = [{ name: "01", input: "1 2\n", output: "3\n" }];
const done = (stdout: string, input = "1 2\n") =>
  ({
    phase: "done",
    id: "r1",
    input,
    result: { status: "OK", exit_code: 0, cpu_ms: 1, wall_ms: 1, max_rss_kb: 1024, stdout, stderr: "", stdout_truncated: false },
  }) as const;

describe("RunPanel", () => {
  it("shows the input limit, and an error once the input exceeds it (counted in bytes)", () => {
    const { rerender } = render(<RunPanel samples={samples} input={"a".repeat(MAX_RUN_INPUT_BYTES)} onInput={() => {}} run={{ phase: "idle" }} />);
    expect(screen.getByLabelText(/Input/)).toBeInTheDocument();
    expect(screen.getByText("(max 64 KB)")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<RunPanel samples={samples} input={"é".repeat(MAX_RUN_INPUT_BYTES / 2 + 1)} onInput={() => {}} run={{ phase: "idle" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/larger than 64 KB/);
  });

  it("says when the output matches the sample, and shows a diff when it does not", () => {
    const { rerender } = render(<RunPanel samples={samples} input="1 2\n" onInput={() => {}} run={done("3\n")} />);
    expect(screen.getByTestId("run-matches")).toHaveTextContent("sample 01");
    rerender(<RunPanel samples={samples} input="1 2\n" onInput={() => {}} run={done("4\n")} />);
    expect(screen.queryByTestId("run-matches")).toBeNull();
    expect(screen.getByText(/Compared with sample 01/)).toBeInTheDocument();
  });

  it("does not compare custom input with any sample", () => {
    render(<RunPanel samples={samples} input="5 5\n" onInput={() => {}} run={done("10\n", "5 5\n")} />);
    expect(screen.getByTestId("run-stdout")).toHaveTextContent("10");
    expect(screen.queryByText(/Compared with/)).toBeNull();
    expect(screen.queryByTestId("run-matches")).toBeNull();
  });
});
