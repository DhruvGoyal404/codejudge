// Phase 5.5 U: problem list and problem page — keyboard use, accessibility
// (axe, WCAG 2.1 A/AA incl. colour contrast) in both themes, and screenshots
// (UI_SCREENSHOTS=1 writes docs/img/ui-*.png).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { enterCode } from "./helpers.ts";
import { solutionPath } from "./stack.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHOTS = process.env.UI_SCREENSHOTS === "1";
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(REPO, "docs", "img", `ui-${name}.png`) });
};

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => window.localStorage.setItem("codejudge:theme", t), theme);
}

/** WCAG 2.1 A/AA. Monaco's own DOM is third-party and excluded. */
async function expectAccessible(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".monaco-editor").analyze();
  const summary = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`problem list: filters, keyboard and accessibility (${theme})`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/");
    const rows = page.getByTestId("problem-rows").locator("tr");
    await expect(rows).toHaveCount(60);
    await expectAccessible(page);
    await shot(page, `list-${theme}`);

    // "/" focuses the search box; typing filters live and lands in the URL.
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.keyboard.type("courier");
    await expect(rows).toHaveCount(2); // Courier Grid, Island Courier
    await expect(page).toHaveURL(/q=courier/);

    // Difficulty buttons and the tag filter combine.
    await page.getByRole("searchbox").fill("");
    await page.getByRole("button", { name: "medium", exact: true }).click();
    await page.getByLabel("Tag").selectOption("graphs");
    await expect(page).toHaveURL(/difficulty=medium.*tag=graphs|tag=graphs.*difficulty=medium/);
    await expect(async () => {
      const shown = await page.getByTestId("problem-rows").getByTestId("difficulty").evaluateAll((els) => els.map((e) => e.getAttribute("data-difficulty")));
      expect(shown.length).toBeGreaterThan(0);
      expect(new Set(shown)).toEqual(new Set(["medium"]));
    }).toPass();
    await expectAccessible(page);
    await shot(page, `list-filtered-${theme}`);

    // Arrow keys move between rows; Enter opens the problem.
    const links = page.getByTestId("problem-rows").locator("a[data-row-link]");
    await links.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(links.first()).toBeFocused();

    // Empty state.
    await page.getByRole("searchbox").fill("no such problem anywhere");
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await shot(page, `list-empty-${theme}`);
    await page.getByTestId("list-empty").getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(60);
  });

  test(`problem page: panes, settings and accessibility (${theme})`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/problems/courier-grid");
    await expect(page.getByRole("heading", { name: "Courier Grid", level: 1 })).toBeVisible();
    await expect(page.getByTestId("statement-pane").getByTestId("difficulty")).toHaveText("Medium");
    await page.locator(".monaco-editor").first().waitFor();
    await expectAccessible(page);
    await shot(page, `problem-${theme}`);

    // The pane splitters are focusable and resize with the arrow keys; sizes persist.
    const vsplit = page.getByRole("separator", { name: "Resize statement and editor" });
    const before = Number(await vsplit.getAttribute("aria-valuenow"));
    await vsplit.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(vsplit).toHaveAttribute("aria-valuenow", String(before + 10));
    const hsplit = page.getByRole("separator", { name: "Resize editor and results" });
    await hsplit.focus();
    await page.keyboard.press("ArrowUp");
    await page.reload();
    await expect(page.getByRole("separator", { name: "Resize statement and editor" })).toHaveAttribute("aria-valuenow", String(before + 10));

    // Editor settings open in place and are remembered.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Font size").selectOption("18");
    await expectAccessible(page);
    await shot(page, `problem-settings-${theme}`);
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel("Font size")).toHaveValue("18");

    // Restore the defaults for the next test.
    await page.evaluate(() => window.localStorage.removeItem("codejudge:prefs"));
  });
}

// Run with custom input, then submit: both tabs of the bottom pane.
for (const theme of ["light", "dark"] as const) {
  test(`run with custom input and the result panel (${theme})`, async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await setTheme(page, theme);
    await page.goto("/problems/range-ledger");
    await page.evaluate(() => {
      window.localStorage.removeItem("codejudge:input:range-ledger");
      window.localStorage.removeItem("codejudge:draft:range-ledger:cpp");
    });
    await page.reload();
    const sol = (f: string) => readFileSync(solutionPath("range-ledger", f), "utf8");

    // The input starts as sample 01; the reference matches its expected output.
    await enterCode(page, sol("ref.cpp"), "prefix");
    await expect(page.getByRole("tab", { name: "Run" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("run-status")).toHaveAttribute("data-status", "OK");
    await expect(page.getByTestId("run-matches")).toContainText("sample 01");
    await expectAccessible(page);
    await shot(page, `run-ok-${theme}`);

    // Custom input: just the program's output, no comparison. Ctrl+' runs.
    await page.getByTestId("run-input").fill("3 2\n5 -2 7\n1 3\n2 2\n");
    await page.keyboard.press("ControlOrMeta+'");
    await expect(page.getByTestId("run-stdout")).toHaveText("10\n-2\n");
    await expect(page.getByTestId("run-matches")).toHaveCount(0);

    // A wrong program on a sample shows the diff against the expected output.
    await page.getByRole("button", { name: "Sample 01" }).click();
    await enterCode(page, sol("wrong.cpp"), "prefix");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const diffLine = page.getByTestId("run-output").locator('[data-kind="expected"]').first();
    await expect(diffLine).toBeAttached();
    await diffLine.scrollIntoViewIfNeeded();
    await expect(diffLine).toBeVisible();
    await shot(page, `run-diff-${theme}`);

    // Submitting switches to the Submission tab and shows the verdict summary.
    await enterCode(page, sol("ref.cpp"), "prefix");
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByRole("tab", { name: "Submission" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("result").getByTestId("verdict")).toHaveAttribute("data-verdict", "AC");
    await expect(page.getByTestId("result-summary")).toContainText("28/28 tests passed");
    await expectAccessible(page);
    await shot(page, `result-ac-${theme}`);

    // Arrow keys switch tabs.
    await page.getByRole("tab", { name: "Submission" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Run" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Run" })).toHaveAttribute("aria-selected", "true");
  });
}
