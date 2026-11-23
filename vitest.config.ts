import { configDefaults, defineConfig } from "vitest/config";
import {
  checkFlakeCases,
  checkFlakeIds,
} from "./packages/host/src/check-flake-cases.js";
import { ciReporters, isolatedReceipts } from "./test-support/ci-reporters.js";

const selected = (value: string | undefined) =>
  process.env.GITHUB_ACTIONS === "true"
    ? checkFlakeIds.filter((id) => value?.split(" ").includes(id))
    : [];
const retryCases = selected(process.env.CARDIGAN_FLAKE_CASES);
const isolated = retryCases.length > 0;
const files = [...new Set(retryCases.map((id) => checkFlakeCases[id].file))];
const exclude = [
  ...configDefaults.exclude,
  ...selected(process.env.CARDIGAN_CHECKED_CASES).map(
    (id) => checkFlakeCases[id].file,
  ),
];
const retryRunner = retryCases.length
  ? { runner: "./test-support/check-flake-runner.ts", provide: { retryCases } }
  : {};
const processContracts = [
  "packages/roles/src/test-worker-limit.test.ts",
  "packages/host/src/worker-claude-opener.integration.test.ts",
  "apps/server/src/diagnostics-reader.test.ts",
  "apps/server/src/mcp-reader.test.ts",
  "apps/cli/src/assignment-attach.test.ts",
  "packages/runtime-herdr/src/runtime.acceptance.test.ts",
];

export default defineConfig({
  test: {
    reporters: isolated
      ? [...ciReporters, isolatedReceipts(retryCases)]
      : ciReporters,
    exclude,
    environment: "node",
    setupFiles: ["./test-support/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          ...retryRunner,
          include: isolated
            ? files
            : ["{packages,apps}/*/src/**/*.test.{ts,tsx}"],
          exclude: [...exclude, "apps/web/**", ...processContracts],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          include: isolated ? [] : ["apps/web/src/**/*.test.{ts,tsx}"],
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
          include: isolated
            ? files.filter((f) => processContracts.includes(f))
            : processContracts,
          // A per-project maxWorkers would be overridden by the CI CLI flag.
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
