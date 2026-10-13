// Phase 5 browser flows: logged-out state, history / detail / profile, owner-only
// code, logout. Users come from the TEST-ONLY auth shortcut (never GitHub).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { BASE_URL, enterCode, newUserContext } from "./helpers.ts";
import { REPO } from "./stack.ts";

const SLUG = "range-ledger";
const REF = readFileSync(join(REPO, "problems", SLUG, "solutions", "ref.cpp"), "utf8");

test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Log in to submit instead of Submit; the link returns to the page; profile asks to log in", async ({ page }) => {
    await page.goto(`/problems/${SLUG}`);
    const login = page.getByRole("link", { name: "Log in to submit" });
    await expect(login).toHaveAttribute("href", `/api/auth/github?next=${encodeURIComponent(`/problems/${SLUG}`)}`);
    await expect(page.getByRole("button", { name: "Submit" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Log in with GitHub" })).toBeVisible();
    await page.goto("/profile");
    await expect(page.getByText("Log in to see your profile")).toBeVisible();
  });

  test("the login link redirects to GitHub with PKCE S256 and read:user (not followed)", async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/auth/github?next=%2Fproblems%2F${SLUG}`, { maxRedirects: 0 });
    expect(r.status()).toBe(302);
    const to = new URL(r.headers()["location"]!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read:user");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/api/auth/github/callback`);
    expect(r.headers()["set-cookie"]).toMatch(/cj_oauth=.*HttpOnly/i);
  });

  test("a failed login shows the error banner", async ({ page }) => {
    await page.goto("/?login_error=state");
    await expect(page.getByRole("alert")).toContainText("expired or was already used");
  });
});

test("history: My submissions, detail page with read-only code, badge, profile; others can't see the code", async ({ browser }) => {
  const ctx = await newUserContext(browser, "history");
  const page = await ctx.newPage();
  await page.goto(`/problems/${SLUG}`);
  await enterCode(page, REF, "prefix");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByTestId("result").getByTestId("verdict")).toHaveAttribute("data-verdict", "AC");

  // My submissions comes from the API.
  const mine = page.getByTestId("my-submissions").getByRole("listitem");
  await expect(mine).toHaveCount(1);
  await expect(mine.first().getByTestId("verdict")).toHaveAttribute("data-verdict", "AC");

  // Detail page: verdict + the code in a read-only editor.
  await mine.first().getByRole("link", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/submissions\/[0-9a-f-]{36}$/);
  const detailUrl = page.url();
  await expect(page.getByTestId("result").getByTestId("verdict")).toHaveAttribute("data-verdict", "AC");
  const code = page.getByTestId("source-view").locator(".view-lines");
  await expect(code).toContainText("prefix");
  await page.getByTestId("source-view").locator(".monaco-editor").click();
  await page.keyboard.type("XYZZY");
  await expect(code).not.toContainText("XYZZY"); // read-only

  // Badge on the problem list, stats and history on the profile.
  await page.goto("/");
  await expect(page.getByRole("row", { name: /Range Ledger/ }).getByTestId("problem-status")).toHaveAttribute("data-status", "solved");
  await page.getByTestId("account").click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByTestId("profile-stats")).toHaveText("1 solved · 0 attempted");
  await expect(page.getByTestId("history-table").getByRole("row")).toHaveCount(2); // header + 1

  // Another user (and an anonymous visitor) sees the result but not the code.
  const other = await newUserContext(browser, "other");
  const otherPage = await other.newPage();
  await otherPage.goto(detailUrl);
  await expect(otherPage.getByTestId("result").getByTestId("verdict")).toHaveAttribute("data-verdict", "AC");
  await expect(otherPage.getByTestId("source-hidden")).toBeVisible();
  await expect(otherPage.getByTestId("source-view")).toHaveCount(0);
  const anon = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  const anonPage = await anon.newPage();
  await anonPage.goto(detailUrl);
  await expect(anonPage.getByTestId("source-hidden")).toBeVisible();

  await Promise.all([ctx.close(), other.close(), anon.close()]);
});

test("logout ends the session immediately", async ({ browser }) => {
  const ctx = await newUserContext(browser, "logout");
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("account")).toContainText("e2e-logout");
  expect((await ctx.request.get(`${BASE_URL}/api/me`)).status()).toBe(200);
  const cookies = await ctx.cookies();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in with GitHub" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Log in with GitHub" })).toBeVisible();

  // Even the old cookie, replayed, no longer works.
  const replay = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies, origins: [] } });
  expect((await replay.request.get(`${BASE_URL}/api/me`)).status()).toBe(401);
  await Promise.all([ctx.close(), replay.close()]);
});
