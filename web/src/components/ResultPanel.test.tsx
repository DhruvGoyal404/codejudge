import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Sample, Submission } from "../api.ts";
import { ResultPanel } from "./ResultPanel.tsx";

const samples: Sample[] = [
  { name: "01", input: "5 3\n1 2 3 4 5\n1 5\n2 4\n3 3\n", output: "15\n9\n3\n" },
  { name: "02", input: "2 2\n-3 7\n1 2\n2 2\n", output: "4\n7\n" },
];

const done = (over: Partial<Submission>): Submission => ({
  id: "s1",
  mine: false,
  problem_slug: "range-ledger",
  language: "cpp",
  status: "done",
  verdict: "AC",
  reason: null,
  failed_test: null,
  failed_is_sample: null,
  max_cpu_ms: 4,
  max_rss_kb: 4600,
  attempt: 1,
  created_at: "",
  started_at: null,
  finished_at: null,
  tests: [],
  ...over,
});

describe("ResultPanel", () => {
  it("shows live stage and progress while running", () => {
    render(<ResultPanel state={{ phase: "running", id: "s1", progress: { stage: "testing", test: 3, total: 10 }, reconnecting: false }} samples={samples} />);
    expect(screen.getByTestId("stage-label")).toHaveTextContent("Running test 3 of 10");
    expect(screen.getByRole("progressbar", { name: "Test progress" })).toHaveAttribute("value", "3");
    const current = within(screen.getByTestId("stages")).getByText("Testing");
    expect(current.className).toContain("bg-blue-600");
  });

  it("shows a reconnecting notice when the stream drops", () => {
    render(<ResultPanel state={{ phase: "queued", id: "s1", reconnecting: true }} samples={samples} />);
    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);
  });

  it("failed SAMPLE: input, expected and a diff with the user's output", () => {
    const s = done({
      verdict: "WA",
      failed_test: "01",
      failed_is_sample: true,
      tests: [{ seq: 1, name: "01", is_sample: true, status: "WA", cpu_ms: 2, rss_kb: 4600, stdout: "14\n7\n0\n", stdout_truncated: false }],
    });
    render(<ResultPanel state={{ phase: "done", id: "s1", submission: s }} samples={samples} />);
    expect(screen.getByTestId("verdict")).toHaveAttribute("data-verdict", "WA");
    const box = screen.getByTestId("failed-sample");
    expect(box).toHaveTextContent("Failed on sample 01 (WA)");
    expect(box).toHaveTextContent("1 2 3 4 5"); // input
    const diff = within(box).getByTestId("diff");
    const kinds = [...diff.querySelectorAll("[data-kind]")].map((n) => `${n.getAttribute("data-kind")}:${n.textContent?.slice(1).trim()}`);
    expect(kinds).toEqual(["expected:15", "expected:9", "expected:3", "actual:14", "actual:7", "actual:0"]);
    expect(screen.queryByTestId("failed-hidden")).toBeNull();
  });

  it("failed HIDDEN test: only its number and status, never input/expected/output", () => {
    const s = done({
      verdict: "WA",
      failed_test: "05",
      failed_is_sample: false,
      tests: [
        { seq: 1, name: "01", is_sample: true, status: "AC", cpu_ms: 1, rss_kb: 4000, stdout: "15\n9\n3\n" },
        { seq: 2, name: "02", is_sample: true, status: "AC", cpu_ms: 1, rss_kb: 4000, stdout: "4\n7\n" },
        { seq: 3, name: "05", is_sample: false, status: "WA", cpu_ms: 1, rss_kb: 4000 },
      ],
    });
    render(<ResultPanel state={{ phase: "done", id: "s1", submission: s }} samples={samples} />);
    expect(screen.getByTestId("failed-hidden")).toHaveTextContent("Failed on hidden test #3: WA");
    expect(screen.queryByTestId("failed-sample")).toBeNull();
    expect(screen.queryByTestId("diff")).toBeNull();
  });

  it("per-test table shows status, CPU and memory", () => {
    const s = done({ tests: [{ seq: 1, name: "01", is_sample: true, status: "AC", cpu_ms: 12, rss_kb: 5120 }] });
    render(<ResultPanel state={{ phase: "done", id: "s1", submission: s }} samples={samples} />);
    const row = within(screen.getByTestId("tests-table")).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("#1");
    expect(row).toHaveTextContent("AC");
    expect(row).toHaveTextContent("12 ms");
    expect(row).toHaveTextContent("5.0 MB");
  });

  it("compile error shows the compiler output", () => {
    render(<ResultPanel state={{ phase: "done", id: "s1", submission: done({ verdict: "CE", reason: "main.cpp:1: error: expected ';'" }) }} samples={samples} />);
    expect(screen.getByText(/expected ';'/)).toBeInTheDocument();
  });

  it("submit error is shown as an alert", () => {
    render(<ResultPanel state={{ phase: "error", message: "Your code is too large (the limit is 64 KB)." }} samples={samples} />);
    expect(screen.getByRole("alert")).toHaveTextContent("64 KB");
  });
});
