// The production page CSP must let the app (and Monaco) work with zero
// violations. Experiments tighten one directive at a time to show which
// permissions are actually needed (results in docs/PHASE6.md § 6a.3).
import { expect, test, type Page } from "@playwright/test";

const SLUG = "range-ledger";

/** Records CSP violations and console errors/warnings for a page. */
async function watch(page: Page) {
  const violations: string[] = [];
  const consoleProblems: string[] = [];
  await page.exposeFunction("__cspViolation", (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(`${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"}`),
    );
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleProblems.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleProblems.push(`pageerror: ${e.message}`));
  // Record the names of Trusted Types policies the app creates.
  const policies: string[] = [];
  await page.exposeFunction("__ttPolicy", (n: string) => policies.push(n));
  await page.addInitScript(() => {
    const tt = (window as unknown as { trustedTypes?: { createPolicy: (n: string, r: unknown) => unknown } }).trustedTypes;
    if (!tt) return;
    const orig = tt.createPolicy.bind(tt);
    tt.createPolicy = (n: string, r: unknown) => {
      (window as unknown as { __ttPolicy: (n: string) => void }).__ttPolicy(n);
      return orig(n, r);
    };
  });
  return { violations, consoleProblems, policies };
}

/** Exercises Monaco: loads, highlights, accepts typing, opens a widget. */
async function useEditor(page: Page) {
  await page.goto(`/problems/${SLUG}`);
  const editor = page.locator(".monaco-editor").first();
  await editor.waitFor();
  await expect(page.locator(".view-lines")).toContainText("#include");
  // Syntax highlighting: tokens get several distinct mtk* classes.
  await expect
    .poll(async () => new Set(await page.locator(".view-lines span[class^=mtk]").evaluateAll((els) => els.map((e) => e.className))).size)
    .toBeGreaterThan(2);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  // insertText: key-by-key typing races Monaco's input handling and drops characters.
  await page.keyboard.insertText("// typed under CSP");
  await expect(page.locator(".view-lines")).toContainText("typed under CSP");
  // The editor web worker (worker-src). Monaco starts it lazily and the trimmed
  // build rarely needs it, so start it the way Monaco does and see it run.
  const worker = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const env = (self as unknown as { MonacoEnvironment: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment;
        const w = env.getWorker("csp-test", "editorWorkerService");
        w.onerror = () => resolve("error");
        setTimeout(() => resolve(performance.getEntriesByType("resource").some((e) => /editor\.worker.*\.js/.test(e.name)) ? "loaded" : "not loaded"), 2000);
      }),
  );
  expect(worker).toBe("loaded");
  // Language switch (tokenizer swap) and dark theme (Monaco injects theme CSS).
  await page.getByLabel("Language").selectOption("python");
  await expect(page.locator(".view-lines")).toContainText("import sys");
  await page.getByLabel("Language").selectOption("java");
  await expect(page.locator(".view-lines")).toContainText("public class Main");
  await page.getByLabel("Language").selectOption("javascript");
  await expect(page.locator(".view-lines")).toContainText("readFileSync");
  await page.getByRole("button", { name: /Switch to (dark|light) mode/ }).click();
  await expect(page.locator(".monaco-editor.vs-dark, .monaco-editor.vs").first()).toBeVisible();
}

test("the production CSP is sent and the app + Monaco work with zero violations", async ({ page }) => {
  const w = await watch(page);
  const res = await page.goto("/");
  const csp = res!.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("require-trusted-types-for 'script'");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // landing
  await page.goto("/problems");
  await expect(page.getByRole("heading", { name: "Problems" })).toBeVisible();
  await useEditor(page);
  await page.goto("/profile");
  await page.goto("/?login_error=state");
  await expect(page.getByRole("alert")).toBeVisible();
  console.log(JSON.stringify({ trustedTypesPolicies: [...new Set(w.policies)].sort() }));
  expect(w.violations).toEqual([]);
  expect(w.consoleProblems.filter((m) => !m.includes("401"))).toEqual([]); // GET /api/me is 401 when logged out
});

// Experiments: start from the production policy (as served) and tighten one
// thing at a time. Findings are recorded in docs/PHASE6.md § 6a.3.
const VARIANTS: Record<string, (csp: string) => string> = {
  "style-src without 'unsafe-inline'": (csp) => csp.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'"),
  "trusted-types without Monaco's policy names": (csp) => csp.replace(/trusted-types [^;]+/, "trusted-types codejudge-worker"),
};

test.describe("experiments: which permissions does Monaco need?", () => {
  test.skip(!process.env.CSP_EXPERIMENTS, "set CSP_EXPERIMENTS=1");
  for (const [name, tighten] of Object.entries(VARIANTS)) {
    test(name, async ({ page }) => {
      await page.route("**/*", async (route) => {
        const r = await route.fetch();
        const headers = { ...r.headers() };
        if (headers["content-security-policy"]) headers["content-security-policy"] = tighten(headers["content-security-policy"]);
        await route.fulfill({ response: r, headers });
      });
      const w = await watch(page);
      let editorOk = true;
      try {
        await useEditor(page);
      } catch {
        editorOk = false;
      }
      const result = { variant: name, editorOk, violations: [...new Set(w.violations)], console: [...new Set(w.consoleProblems)].slice(0, 3) };
      console.log(JSON.stringify(result));
      test.info().annotations.push({ type: "result", description: JSON.stringify(result) });
    });
  }
});
