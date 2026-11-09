import { afterAll } from "vitest";
import { createPrivateTestRoot, removeEmptyTestRoot } from "./paths.js";

const root = createPrivateTestRoot();
// Only this Vitest worker is changed, never the host or the check supervisor.
// Existing fixtures keep their individual mkdtemp/rm lifecycle and assertions.
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;
afterAll(() => removeEmptyTestRoot(root));
process.once("exit", () => removeEmptyTestRoot(root));
