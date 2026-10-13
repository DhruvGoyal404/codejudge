// Checks a RUNNING production build (Caddy + API), e.g. the local prod test
// stack or the real site: CSP, Monaco, headers. Starts no servers.
//
//   PROD_URL=https://localhost:8444 npx playwright test -c playwright.prod.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e-prod",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PROD_URL ?? "https://localhost:8444",
    // The local test stack uses Caddy's internal CA.
    ignoreHTTPSErrors: !process.env.PROD_URL || process.env.PROD_URL.includes("localhost"),
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
