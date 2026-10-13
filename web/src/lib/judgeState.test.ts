import { describe, expect, it } from "vitest";

import type { Submission } from "../api.ts";
import { judgeReducer, stageLabel, type JudgeEvent, type JudgeState } from "./judgeState.ts";

const sub = (over: Partial<Submission> = {}): Submission => ({
  id: "s1",
  mine: false,
  problem_slug: "ledger-total",
  language: "cpp",
  status: "done",
  verdict: "AC",
  reason: null,
  failed_test: null,
  failed_is_sample: null,
  max_cpu_ms: 3,
  max_rss_kb: 4000,
  attempt: 1,
  created_at: "2026-10-13T00:00:00Z",
  started_at: null,
  finished_at: null,
  tests: [],
  ...over,
});

const run = (events: JudgeEvent[], from: JudgeState = { phase: "idle" }) => events.reduce(judgeReducer, from);

describe("judgeReducer", () => {
  it("walks queued -> compiling -> test k/n -> verdict", () => {
    const steps: JudgeEvent[] = [
      { type: "SUBMIT" },
      { type: "SUBMITTED", id: "s1" },
      { type: "STATUS", id: "s1", status: "queued" },
      { type: "STATUS", id: "s1", status: "running" },
      { type: "PROGRESS", id: "s1", stage: "compiling", test: 0, total: 11 },
      { type: "PROGRESS", id: "s1", stage: "testing", test: 1, total: 11 },
      { type: "PROGRESS", id: "s1", stage: "testing", test: 7, total: 11 },
      { type: "STATUS", id: "s1", status: "done" },
      { type: "VERDICT", submission: sub() },
    ];
    const labels: string[] = [];
    let s: JudgeState = { phase: "idle" };
    for (const e of steps) {
      s = judgeReducer(s, e);
      labels.push(stageLabel(s));
    }
    expect(labels).toEqual([
      "Submitting…",
      "Queued",
      "Queued",
      "Running",
      "Compiling",
      "Running test 1 of 11",
      "Running test 7 of 11",
      "Running test 7 of 11", // status "done" alone carries no verdict
      "AC",
    ]);
    expect(s).toMatchObject({ phase: "done", id: "s1" });
  });

  it("never moves progress backwards (late or duplicate events)", () => {
    const s = run([
      { type: "SUBMITTED", id: "s1" },
      { type: "PROGRESS", id: "s1", stage: "testing", test: 5, total: 10 },
      { type: "PROGRESS", id: "s1", stage: "testing", test: 3, total: 10 },
      { type: "PROGRESS", id: "s1", stage: "compiling", test: 0, total: 10 },
    ]);
    expect(stageLabel(s)).toBe("Running test 5 of 10");
  });

  it("ignores events for other submissions and anything after the verdict", () => {
    const s = run([
      { type: "SUBMITTED", id: "s1" },
      { type: "PROGRESS", id: "other", stage: "testing", test: 9, total: 9 },
      { type: "VERDICT", submission: sub({ verdict: "WA" }) },
      { type: "PROGRESS", id: "s1", stage: "testing", test: 2, total: 9 },
      { type: "STATUS", id: "s1", status: "running" },
    ]);
    expect(s).toMatchObject({ phase: "done" });
    expect(stageLabel(s)).toBe("WA");
  });

  it("marks reconnecting on connection loss and resyncs from the authoritative submission", () => {
    let s = run([
      { type: "SUBMITTED", id: "s1" },
      { type: "STATUS", id: "s1", status: "running" },
      { type: "CONNECTION_LOST", id: "s1" },
    ]);
    expect(s).toMatchObject({ phase: "running", reconnecting: true });
    // The verdict was missed while disconnected: the re-fetch delivers it.
    s = judgeReducer(s, { type: "RESYNC", submission: sub({ verdict: "TLE" }) });
    expect(s).toMatchObject({ phase: "done", submission: { verdict: "TLE" } });
  });

  it("resync while still running keeps the latest progress and clears reconnecting", () => {
    const s = run([
      { type: "SUBMITTED", id: "s1" },
      { type: "PROGRESS", id: "s1", stage: "testing", test: 4, total: 10 },
      { type: "CONNECTION_LOST", id: "s1" },
      { type: "RESYNC", submission: sub({ status: "running", verdict: null }) },
    ]);
    expect(s).toMatchObject({ phase: "running", reconnecting: false, progress: { test: 4 } });
  });

  it("submit failure shows the error; a new submit recovers", () => {
    let s = run([{ type: "SUBMIT" }, { type: "SUBMIT_FAILED", message: "Your code is too large (the limit is 64 KB)." }]);
    expect(s).toEqual({ phase: "error", message: "Your code is too large (the limit is 64 KB)." });
    s = run([{ type: "SUBMIT" }, { type: "SUBMITTED", id: "s2" }], s);
    expect(s).toMatchObject({ phase: "queued", id: "s2" });
  });

  it("SUBMIT while already submitting is a no-op (double click)", () => {
    const s1: JudgeState = { phase: "submitting" };
    expect(judgeReducer(s1, { type: "SUBMIT" })).toBe(s1);
  });
});
