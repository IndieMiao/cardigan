import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("opt-in Godot import isolates new worktrees and falls back to a cold import", () => {
  execFileSync(
    "python3",
    [
      "-IB",
      fileURLToPath(
        new URL("../test-support/godot-import.py", import.meta.url),
      ),
    ],
    { timeout: 120_000 },
  );
}, 125_000);
