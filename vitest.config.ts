import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test-support/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["{packages,apps}/*/src/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "apps/web/**"],
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
    ],
  },
});
