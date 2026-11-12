import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

/** Entry points of every workspace package that apps/server and apps/cli load. */
export const PACKAGE_DIST_ENTRIES = [
  "domain",
  "git-service",
  "git-transport",
  "host",
  "mcp-server",
  "roles",
  "router",
  "runtime-herdr",
  "store",
].map((name) => `packages/${name}/dist/index.js`);

/**
 * Tests that load compiled workspace packages or spawn a built CLI need their
 * `dist` output. A checkout without it (for example a read-only verification
 * worktree that was never built) must fail with the cause and the build command,
 * not with a module-resolution error or a timed-out assertion further on.
 *
 * Paths are relative to the workspace root. When a test file imports compiled
 * packages statically, call this from `vi.hoisted` so it runs before them.
 */
export function requireBuildOutput(
  files: readonly string[],
  buildCommand: string,
): void {
  const missing = files.filter(
    (file) => !existsSync(join(workspaceRoot, file)),
  );
  if (missing.length === 0) return;
  throw new Error(
    `Missing build output: ${missing.join(", ")}. This test uses compiled ` +
      `packages; run \`${buildCommand}\` in a writable checkout first ` +
      "(`pnpm build` builds everything).",
  );
}
