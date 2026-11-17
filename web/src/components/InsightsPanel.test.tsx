import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Insight } from "../api.ts";
import { bigO, InsightsPanel, InsightsTeaser } from "./InsightsPanel.tsx";

const quadTLE: Insight = {
  eligible: true,
  reason: null,
  label: "n = number of items",
  reference: "n or n log n",
  status: "done",
  error: null,
  hints: [{ line: 7, kind: "nested-loops", message: "This loop and the one on line 6 both scan all of `a`: together about n² steps." }],
  report: {
    status: "ok",
    label: "n = number of items",
    steps: [
      { n: 1000, cpu_ms: 6, rss_kb: 4000, status: "OK" },
      { n: 10000, cpu_ms: 90, rss_kb: 4200, status: "OK" },
      { n: 30000, cpu_ms: 800, rss_kb: 4400, status: "OK" },
      { n: 40000, cpu_ms: 1400, rss_kb: 4500, status: "TLE" },
    ],
    baseline_cpu_ms: 4,
    time: { class: "n^2", confidence: 0.97, offset: 5, scale: 8.9e-7 },
    memory: { class: "fast", confidence: 0, offset: 0, scale: 0 },
    time_limit_ms: 1000,
    max_n: 100000,
    predicted_ms: 8900,
    stopped_by: "TLE",
    cpu_spent_ms: 3000,
  },
};

function show(data: Insight) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InsightsPanel id="00000000-0000-4000-8000-000000000000" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("bigO", () => {
  it("formats classes and pairs", () => {
    expect(bigO("n^2")).toBe("O(n²)");
    expect(bigO("n or n log n")).toBe("O(n) or O(n log n)");
    expect(bigO("2^(n/2)")).toBe("O(2ⁿᐟ²)");
    expect(bigO("2^n")).toBe("O(2ⁿ)");
  });
});

describe("InsightsPanel", () => {
  it("explains why a submission can't be analyzed, with no button", async () => {
    show({ ...quadTLE, eligible: false, reason: "Wait for the verdict first.", status: "none", report: null });
    expect(await screen.findByText("Wait for the verdict first.")).toBeInTheDocument();
    expect(screen.queryByTestId("insights-start")).toBeNull();
  });

  it("offers the analysis when eligible", async () => {
    show({ ...quadTLE, status: "none", report: null });
    expect(await screen.findByRole("button", { name: "Analyze my solution" })).toBeInTheDocument();
  });

  it("shows the class, the reference, why it hit the limit, and an accessible chart", async () => {
    show(quadTLE);
    expect(await screen.findByTestId("insights-headline")).toHaveTextContent("grows like O(n²)");
    expect(screen.getByTestId("insights-reference")).toHaveTextContent("O(n) or O(n log n)");
    expect(screen.getByTestId("insights-limit")).toHaveTextContent("exceeded the 1.0 s limit at n = 40,000");
    expect(screen.getByTestId("insights-limit")).toHaveTextContent("about 8.9 s");
    expect(screen.getByRole("img", { name: /CPU time by input size/ })).toBeInTheDocument();
    expect(screen.getByTestId("insights-hints")).toHaveTextContent("line 7");
    expect(screen.getByTestId("insights-hints")).toHaveTextContent("not the verdict");
  });

  it("never claims a class when the program was too fast to measure", async () => {
    show({ ...quadTLE, report: { ...quadTLE.report!, stopped_by: undefined, predicted_ms: undefined, time: { class: "fast", confidence: 0, offset: 0, scale: 0 } } });
    expect(await screen.findByTestId("insights-headline")).toHaveTextContent("too fast");
    expect(screen.queryByText(/Confidence/)).toBeNull();
  });
});

function teaser(data: Insight, verdict = "TLE") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InsightsTeaser id="00000000-0000-4000-8000-000000000000" verdict={verdict} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InsightsTeaser (under the verdict on the problem page)", () => {
  it("summarizes a cached result and links to the full panel", async () => {
    teaser(quadTLE);
    expect(await screen.findByTestId("insights-teaser")).toHaveTextContent("grows like O(n²)");
    expect(screen.getByTestId("insights-link")).toHaveAttribute("href", "/submissions/00000000-0000-4000-8000-000000000000#insights");
  });

  it("offers the analysis when there is none yet", async () => {
    teaser({ ...quadTLE, status: "none", report: null });
    expect(await screen.findByRole("button", { name: "Analyze my solution" })).toBeInTheDocument();
  });

  it("stays out of the way for other verdicts", () => {
    const { container } = teaser(quadTLE, "WA");
    expect(container).toBeEmptyDOMElement();
  });
});
