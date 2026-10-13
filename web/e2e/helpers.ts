import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

export const BASE_URL = "http://localhost:5173";

/**
 * Logs `request` in through the TEST-ONLY shortcut (POST /api/test/login;
 * the API mounts it only with NODE_ENV=test). The session cookie lands in the
 * request context's cookie jar (shared with its browser context).
 */
export async function testLogin(request: APIRequestContext, login: string): Promise<{ id: number; login: string }> {
  const r = await request.post(`${BASE_URL}/api/test/login`, { headers: { Origin: BASE_URL }, data: { login } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

/** A fresh browser context logged in as a brand-new throwaway user. */
export async function newUserContext(browser: Browser, login: string) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    storageState: { cookies: [], origins: [] },
  });
  await testLogin(context.request, login);
  return context;
}

/**
 * Puts code into Monaco by pasting it: typing character by character would
 * trigger auto-indent and bracket auto-closing and corrupt the source.
 */
export async function enterCode(page: Page, code: string, expectText: string) {
  const editor = page.locator(".monaco-editor").first();
  await editor.waitFor();
  await editor.click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".view-lines")).toContainText(expectText);
}
