import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { enterCode as pasteCode } from "./helpers.ts";
import { REPO, solutionPath } from "./stack.ts";

// range-ledger: its wrong solution (off-by-one) fails on SAMPLE 01, so the WA
// case exercises the sample diff view.
const SLUG = "range-ledger";
const solution = (file: string) => readFileSync(solutionPath(SLUG, file), "utf8");
const SHOTS = process.env.PHASE4_SCREENSHOTS === "1"; // write docs/img/phase4-*.png
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(REPO, "docs", "img", `phase4-${name}.png`) });
};

const enterCode = (page: Page, code: string) => pasteCode(page, code, "prefix");

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("problem list -> problem page -> C++ reference is Accepted", async ({ page }) => {
  await page.goto("/problems");
  await expect(page.getByRole("heading", { name: "Problems" })).toBeVisible();
  await page.getByRole("link", { name: "Range Ledger" }).click();
  await expect(page.getByRole("heading", { name: "Range Ledger", level: 1 })).toBeVisible();
  await expect(page.getByText("Sample 01 input")).toBeVisible();
  await enterCode(page, solution("ref.cpp"));
  await shot(page, "problem-page");

  await page.getByRole("button", { name: "Submit" }).click();
  // Live stages: queued -> compiling -> running test k of n.
  await expect(page.getByTestId("stage-label")).toHaveText(/Queued|Compiling|Running/);
  await expect(page.getByTestId("stage-label")).toHaveText(/Compiling|Running test \d+ of \d+/);
  await shot(page, "live-stages");

  await expect(page.getByTestId("result").getByTestId("verdict")).toHaveAttribute("data-verdict", "AC");
  // One row per test plus the header; the count comes from the summary
  // ("N/N tests passed"), so adding tests to the problem does not break this.
  const summary = (await page.getByTestId("result-summary").textContent()) ?? "";
  const tests = Number(/(\d+)\/\1 tests passed/.exec(summary)?.[1]);
  expect(tests).toBeGreaterThanOrEqual(45);
  await expect(page.getByTestId("tests-table").getByRole("row")).toHaveCount(tests + 1);
  await expect(page.getByTestId("my-submissions").getByRole("listitem")).toHaveCount(1);
  await shot(page, "ac");
});

test("wrong solution: WA on a sample shows input, expected and the diff", async ({ page }) => {
  await page.goto(`/problems/${SLUG}`);
  await enterCode(page, solution("wrong.cpp"));
  await page.keyboard.press("ControlOrMeta+Enter"); // keyboard shortcut submits

  await expect(page.getByTestId("result").getByTestId("verdict")).toHaveAttribute("data-verdict", "WA");
  const failed = page.getByTestId("failed-sample");
  await expect(failed).toContainText("Failed on sample 01 (WA)");
  const diff = failed.getByTestId("diff");
  await expect(diff.locator('[data-kind="expected"]')).toHaveText(["−15", "−9", "−3"]);
  await expect(diff.locator('[data-kind="actual"]')).toHaveText(["+14", "+7", "+0"]);
  await expect(page.getByTestId("failed-hidden")).toHaveCount(0);
  await shot(page, "wa-sample-diff");
});

test("draft is kept per problem and language across reloads", async ({ page }) => {
  await page.goto(`/problems/${SLUG}`);
  await enterCode(page, "// prefix draft for cpp\n");
  await page.reload();
  await expect(page.locator(".view-lines")).toContainText("prefix draft for cpp");
  await page.getByLabel("Language").selectOption("python");
  await expect(page.locator(".view-lines")).toContainText("import sys");
  await page.getByLabel("Language").selectOption("cpp");
  await expect(page.locator(".view-lines")).toContainText("prefix draft for cpp");
});

test("tablet width layout and dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 }); // iPad portrait
  await page.goto(`/problems/${SLUG}`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  // No horizontal page overflow; statement and editor stack vertically.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const statement = await page.getByTestId("statement-pane").boundingBox();
  const editorPane = await page.getByRole("region", { name: "Editor and results" }).boundingBox();
  expect(editorPane!.y).toBeGreaterThanOrEqual(statement!.y + statement!.height - 1);

  // Dark mode toggle applies the class and persists across reloads.
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
});
