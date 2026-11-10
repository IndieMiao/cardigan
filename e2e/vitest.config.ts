import { defineConfig } from "vitest/config";

/**
 * The Appendix A end-to-end run lives outside `pnpm test` (M5 plan §2, §4 M5.5):
 * it needs the pinned `hc` runtime, real Git and real Agent processes, takes
 * minutes, and starts a herdr-core. Run it with `pnpm test:e2e`.
 *
 * One file, one process: two cores on one socket would fight, and the scenario
 * is sequential by nature.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
    setupFiles: ["../test-support/setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // The scenario spends its time waiting for real processes, not spinning.
    teardownTimeout: 120_000,
  },
});
