// Full-stack browser tests: compose Postgres + Valkey must be up (docker compose
// up -d --wait). Playwright starts the API and Vite; global-setup starts a real
// judge-worker. Run alone: `npm run e2e` (never alongside other suites).
import { defineConfig } from "@playwright/test";

import { STATE_FILE } from "./e2e/global-setup.ts";
import { stackEnv } from "./e2e/stack.ts";

const env = {
  ...stackEnv(),
  LOG_LEVEL: "warn",
  // TEST ONLY: POST /test/login (the API refuses to start with it unless NODE_ENV=test).
  NODE_ENV: "test",
  TEST_AUTH_SHORTCUT: "1",
  // Specs share few users and submit several times within a minute.
  SUBMIT_LIMIT_PER_MIN: "60",
  RUN_LIMIT_PER_MIN: "60",
};

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 120_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Logs in once through the test-only shortcut and saves the browser state.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", use: { browserName: "chromium", storageState: STATE_FILE }, dependencies: ["setup"] },
  ],
  webServer: [
    {
      command: "npx tsx src/server.ts",
      cwd: "../api",
      url: "http://127.0.0.1:8080/health",
      env,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npx vite",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
