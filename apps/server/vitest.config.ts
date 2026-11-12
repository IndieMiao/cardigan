import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// C-155: Vitest only reads the config in its working directory. Running it
// from this package (e.g. `pnpm --filter <pkg> exec vitest run`) would skip
// the root config and with it test-support/setup.ts, so tests would see the
// caller's HOME, XDG_CONFIG_HOME and CARDIGAN_* paths. Load the same setup.
// The root run uses its own inline projects and ignores this file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: [
      fileURLToPath(new URL("../../test-support/setup.ts", import.meta.url)),
    ],
  },
});
