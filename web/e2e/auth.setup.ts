// "setup" project: one logged-in user (via the test-only shortcut) whose
// browser state every "chromium" test starts from.
import { test as setup } from "@playwright/test";

import { STATE_FILE } from "./global-setup.ts";
import { testLogin } from "./helpers.ts";

setup("log in through the test-only auth shortcut", async ({ request }) => {
  await testLogin(request, "playwright");
  await request.storageState({ path: STATE_FILE });
});
