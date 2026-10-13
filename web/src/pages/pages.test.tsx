import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryItem, Submission } from "../api.ts";
import { ProblemList } from "./ProblemList.tsx";
import { ProfilePage } from "./ProfilePage.tsx";
import { SubmissionPage } from "./SubmissionPage.tsx";

// Monaco does not run in jsdom; the read-only view is a plain element here.
vi.mock("../editor/CodeEditor.tsx", () => ({
  default: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <pre data-testid="monaco" data-readonly={String(!!readOnly)}>
      {value}
    </pre>
  ),
}));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ME = { id: 1, github_id: 2, login: "octocat", avatar_url: null };
const PROBLEMS = [
  { slug: "ledger-total", title: "Ledger Total", time_limit_ms: 1000, memory_limit_mb: 256, my_status: "solved" },
  { slug: "range-ledger", title: "Range Ledger", time_limit_ms: 1000, memory_limit_mb: 256, my_status: "attempted" },
  { slug: "rising-towers", title: "Rising Towers", time_limit_ms: 1000, memory_limit_mb: 256, my_status: null },
];

function setup(url: string, element: React.ReactNode, path: string, handler: (path: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return handler(String(input));
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const submission = (over: Partial<Submission>): Submission => ({
  id: "11111111-2222-4333-8444-555555555555",
  problem_slug: "ledger-total",
  language: "cpp",
  status: "done",
  verdict: "AC",
  reason: null,
  failed_test: null,
  failed_is_sample: null,
  max_cpu_ms: 3,
  max_rss_kb: 2048,
  attempt: 1,
  created_at: "2026-10-13T10:00:00Z",
  started_at: "2026-10-13T10:00:01Z",
  finished_at: "2026-10-13T10:00:02Z",
  tests: [],
  mine: false,
  ...over,
});

describe("SubmissionPage", () => {
  const problem = { ...PROBLEMS[0], statement_md: "# Ledger Total", checker: { type: "exact" }, samples: [] };

  it("shows the author's code in a read-only editor", async () => {
    const s = submission({ mine: true, source: "int main() { return 0; }" });
    setup(`/submissions/${s.id}`, <SubmissionPage dark={false} />, "/submissions/:id", (p) =>
      p.startsWith("/api/submissions/") ? json(200, s) : json(200, problem),
    );
    const code = await screen.findByTestId("monaco");
    expect(code).toHaveTextContent("int main() { return 0; }");
    expect(code).toHaveAttribute("data-readonly", "true");
    expect(screen.getByTestId("result")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ledger Total" })).toHaveAttribute("href", "/problems/ledger-total");
  });

  it("says the code is private when the viewer is not the author", async () => {
    const s = submission({ mine: false });
    setup(`/submissions/${s.id}`, <SubmissionPage dark={false} />, "/submissions/:id", (p) =>
      p.startsWith("/api/submissions/") ? json(200, s) : json(200, problem),
    );
    expect(await screen.findByTestId("source-hidden")).toHaveTextContent("visible only to its author");
    expect(screen.queryByTestId("monaco")).toBeNull();
  });

  it("404 -> not found", async () => {
    setup("/submissions/nope", <SubmissionPage dark={false} />, "/submissions/:id", () => json(404, { error: "submission not found" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Submission not found.");
  });
});

describe("ProblemList badges", () => {
  it("shows Solved / Attempted per problem", async () => {
    setup("/", <ProblemList />, "/", () => json(200, { problems: PROBLEMS }));
    const rows = await screen.findAllByRole("row");
    const statusOf = (title: string) => rows.find((r) => within(r).queryByText(title))?.querySelector("[data-testid=problem-status]")?.getAttribute("data-status") ?? null;
    expect(statusOf("Ledger Total")).toBe("solved");
    expect(statusOf("Range Ledger")).toBe("attempted");
    expect(statusOf("Rising Towers")).toBeNull();
  });
});

describe("ProfilePage", () => {
  const item = (i: number): HistoryItem => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    problem_slug: "ledger-total",
    problem_title: "Ledger Total",
    language: "cpp",
    status: "done",
    verdict: i % 2 ? "WA" : "AC",
    max_cpu_ms: i,
    max_rss_kb: 1024,
    created_at: "2026-10-13T10:00:00Z",
    finished_at: "2026-10-13T10:00:01Z",
  });

  it("logged out: asks to log in", async () => {
    setup("/profile", <ProfilePage />, "/profile", (p) => (p === "/api/me" ? json(401, { error: "login required" }) : json(500, {})));
    expect(await screen.findByRole("link", { name: "Log in with GitHub" })).toBeInTheDocument();
  });

  it("stats, history with Load more (cursor), and filters in the request", async () => {
    const calls = setup("/profile?problem=ledger-total", <ProfilePage />, "/profile", (p) => {
      if (p === "/api/me") return json(200, ME);
      if (p === "/api/problems") return json(200, { problems: PROBLEMS });
      const u = new URL(p, "http://x");
      if (u.pathname === "/api/me/submissions") {
        return u.searchParams.get("cursor") === "c2"
          ? json(200, { submissions: [item(3)], next_cursor: null })
          : json(200, { submissions: [item(1), item(2)], next_cursor: "c2" });
      }
      return json(404, {});
    });
    await waitFor(() => expect(screen.getByTestId("profile-stats")).toHaveTextContent("1 solved · 1 attempted"));
    const table = await screen.findByTestId("history-table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(screen.getByTestId("history-table")).getAllByRole("row")).toHaveLength(4));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const historyCalls = calls.filter((c) => c.startsWith("/api/me/submissions"));
    expect(historyCalls[0]).toBe("/api/me/submissions?problem=ledger-total&limit=20");
    expect(historyCalls[1]).toBe("/api/me/submissions?problem=ledger-total&limit=20&cursor=c2");

    fireEvent.change(screen.getByLabelText("Filter by verdict"), { target: { value: "AC" } });
    await waitFor(() => expect(calls.at(-1)).toBe("/api/me/submissions?problem=ledger-total&verdict=AC&limit=20"));
  });
});
