import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, submitErrorMessage } from "../api.ts";
import { loginErrorMessage } from "../lib/useMe.ts";
import { Layout } from "./Layout.tsx";

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderAt(url: string, routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const key = `${init?.method ?? "GET"} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler();
  });
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Layout dark={false} onToggleDark={() => {}}>
          <p>page</p>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("header account controls", () => {
  it("logged out: a GitHub login link that returns to the current page", async () => {
    renderAt("/problems/ledger-total?x=1", { "GET /api/me": () => json(401, { error: "login required" }) });
    const link = await screen.findByRole("link", { name: "Log in with GitHub" });
    expect(link.getAttribute("href")).toBe(`/api/auth/github?next=${encodeURIComponent("/problems/ledger-total?x=1")}`);
  });

  it("logged in: login name and avatar, and Log out POSTs /auth/logout then shows the login link", async () => {
    const fetchMock = renderAt("/", {
      "GET /api/me": () => json(200, { id: 1, github_id: 2, login: "octocat", avatar_url: "https://avatars.example/1" }),
      "POST /api/auth/logout": () => new Response(null, { status: 204 }),
    });
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("link", { name: "Log in with GitHub" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
  });
});

describe("login error banner", () => {
  it("shows the API's login_error and can be dismissed", async () => {
    renderAt("/?login_error=denied", { "GET /api/me": () => json(401, { error: "login required" }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub login was cancelled.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("maps codes to messages", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage("state")).toMatch(/expired or was already used/);
    expect(loginErrorMessage("github")).toMatch(/GitHub login failed/);
    expect(loginErrorMessage("<script>")).toBe("Login failed. Please try again.");
  });
});

describe("submit error messages for auth and limits", () => {
  it("401, 409 and 429 (with Retry-After)", () => {
    expect(submitErrorMessage(new ApiError(401, "login required"))).toMatch(/Log in to submit/);
    expect(submitErrorMessage(new ApiError(409, "x"))).toMatch(/2 submissions being judged/);
    expect(submitErrorMessage(new ApiError(429, "x", undefined, 42))).toBe("Too many submissions. Try again in 42 s.");
    expect(submitErrorMessage(new ApiError(429, "x", undefined, 600))).toBe("Too many submissions. Try again in 10 min.");
    expect(submitErrorMessage(new ApiError(429, "x", undefined, 86_000))).toBe("Too many submissions. Try again in 24 h.");
    expect(submitErrorMessage(new ApiError(429, "x"))).toBe("Too many submissions. Try again later.");
  });
});
