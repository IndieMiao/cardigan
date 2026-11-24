import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createPrivateTestRoot, removeEmptyTestRoot } from "./paths.js";

const root = createPrivateTestRoot();
const configHome = join(root, "config");
const configDir = join(configHome, "cardigan");
const dataDir = join(root, "data");
for (const path of [configHome, configDir, dataDir])
  mkdirSync(path, { mode: 0o700 });
// Override inherited application paths too: tests must never discover host
// launch secrets, gate settings or the Workbench database by default.
process.env.CARDIGAN_CONFIG_DIR = configDir;
process.env.XDG_CONFIG_HOME = configHome;
process.env.CARDIGAN_DATA_DIR = dataDir;
// Node-based child CLIs can enable a cache in TMPDIR after fixtures have removed
// their own data. Disable it in this worker's descendants so empty-root cleanup
// remains safe; do not recursively delete unknown data or active hc sockets.
process.env.NODE_DISABLE_COMPILE_CACHE = "1";
// Temporary workspaces must not bootstrap a different pnpm from the network.
process.env.COREPACK_ENABLE_NETWORK = "0";
// Only this Vitest worker is changed, never the host or the check supervisor.
// Existing fixtures keep their individual mkdtemp/rm lifecycle and assertions.
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;
// C-655: telemetry lookups on arrays derived from command-state events throw
// (`setTelemetryQueryGuard` in packages/domain/src/event-index.ts).
(globalThis as { [key: symbol]: unknown })[
  Symbol.for("cardigan.telemetryQueryGuard")
] = true;
const cleanup = () => {
  for (const path of [configDir, configHome, dataDir, root])
    removeEmptyTestRoot(path);
};
afterAll(cleanup);
process.once("exit", cleanup);
