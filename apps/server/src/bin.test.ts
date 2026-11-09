import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CARDIGAN_MCP_PORT: "invalid",
};
delete env.NODE_OPTIONS;
delete env.NODE_NO_WARNINGS;
delete env.NODE_REDIRECT_WARNINGS;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
      ),
      "-b",
      serverRoot,
    ],
    { stdio: "pipe" },
  );
}, 30_000);

test.each([false, true])(
  "built server keeps one-line startup errors without SQLite warnings (inject: %s)",
  (inject) => {
    const preload = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:sqlite') {
          process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
          process.emitWarning('Another server warning', 'ExperimentalWarning');
        }
        return nextResolve(specifier, context);
      } });
    `;
    const args = inject
      ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, bin]
      : [bin];
    // Invalid configuration exits before opening a database or any listeners.
    const result = spawnSync(process.execPath, args, {
      cwd: serverRoot,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const error =
      'CARDIGAN_MCP_PORT must be an integer between 0 and 65535, got "invalid"\n';
    if (inject) {
      expect(result.stderr).toContain(error);
      expect(result.stderr).toContain(
        "ExperimentalWarning: Another server warning",
      );
      expect(result.stderr).not.toContain("SQLite is an experimental feature");
    } else {
      expect(result.stderr).toBe(error);
    }
  },
);
