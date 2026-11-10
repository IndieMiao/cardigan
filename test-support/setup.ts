import { afterAll } from "vitest";
import { createPrivateTestRoot, removeEmptyTestRoot } from "./paths.js";

const root = createPrivateTestRoot();
// Node-based child CLIs can enable a cache in TMPDIR after fixtures have removed
// their own data. Disable it in this worker's descendants so empty-root cleanup
// remains safe; do not recursively delete unknown data or active hc sockets.
process.env.NODE_DISABLE_COMPILE_CACHE = "1";
// Only this Vitest worker is changed, never the host or the check supervisor.
// Existing fixtures keep their individual mkdtemp/rm lifecycle and assertions.
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;
afterAll(() => removeEmptyTestRoot(root));
process.once("exit", () => removeEmptyTestRoot(root));
