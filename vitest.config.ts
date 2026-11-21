import { configDefaults, defineConfig } from "vitest/config";
import { checkFlakeIds } from "./packages/host/src/check-flake-cases.js";
import { ciReporters } from "./test-support/ci-reporters.js";

const retryCases =
  process.env.GITHUB_ACTIONS === "true"
    ? checkFlakeIds.filter((id) =>
        process.env.CARDIGAN_FLAKE_CASES?.split(" ").includes(id),
      )
    : [];
const retryRunner = retryCases.length
  ? { runner: "./test-support/check-flake-runner.ts", provide: { retryCases } }
  : {};
const processContracts = [
  "packages/roles/src/test-worker-limit.test.ts",
  "packages/host/src/worker-claude-opener.integration.test.ts",
  "apps/server/src/diagnostics-reader.test.ts",
  "apps/cli/src/assignment-attach.test.ts",
  "packages/runtime-herdr/src/runtime.acceptance.test.ts",
];

export default defineConfig({
  test: {
    reporters: ciReporters,
    environment: "node",
    setupFiles: ["./test-support/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          ...retryRunner,
          include: ["{packages,apps}/*/src/**/*.test.{ts,tsx}"],
          exclude: [
            ...configDefaults.exclude,
            "apps/web/**",
            ...processContracts,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          // DOM rendering and accessibility queries compete for CPU. Keep
          // web workers bounded and run them after the other packages.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "process-contract",
          ...retryRunner,
          include: processContracts,
          // A per-project maxWorkers would be overridden by the CI CLI flag.
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
