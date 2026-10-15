// Records failed tests in FAILED_MARKER (global teardown then keeps the
// database rows as evidence instead of deleting them).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { FAILED_MARKER } from "./stack.ts";

export default class FailureReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== test.expectedStatus) {
      mkdirSync(dirname(FAILED_MARKER), { recursive: true });
      appendFileSync(FAILED_MARKER, `${result.status}: ${test.titlePath().join(" > ")}\n`);
    }
  }
}
