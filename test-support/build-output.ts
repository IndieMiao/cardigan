import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Tests that load compiled workspace packages or spawn a built CLI need their
 * `dist` output. A checkout without it (for example a read-only verification
 * worktree that was never built) must fail with the cause and the build command,
 * not with a module-resolution error or a timed-out assertion further on.
 */
export function requireBuildOutput(
  files: readonly string[],
  buildCommand: string,
): void {
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length === 0) return;
  throw new Error(
    `Missing build output: ${missing
      .map((file) => relative(workspaceRoot, file))
      .join(
        ", ",
      )}. This test uses compiled packages; run \`${buildCommand}\` ` +
      "in a writable checkout first (`pnpm build` builds everything).",
  );
}
