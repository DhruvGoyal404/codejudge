import { defineConfig } from "vitest/config";

// End-to-end suite: spawns judge-worker processes and sandbox containers.
// Runs files sequentially and never in parallel with other suites.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
