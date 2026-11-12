import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test.each(["MCP", "Web"])(
  "built server exits with a Chinese port error when the %s wait expires",
  async (listener) => {
    const dataDir = mkdtempSync(join(tmpdir(), "cardigan-bind-"));
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const port = (occupied.address() as { port: number }).port;
    // This failure precedes control-plane startup. Stub only the external
    // runtime wiring; config parsing, SQLite, sockets and bin exit are real.
    const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith('/server/dist/host.js')) return {
        format: 'module', shortCircuit: true,
        source: 'export const createHostWiring = async () => ({runtime: {}}); export const configDir = () => ""; export const loadLaunchFiles = async () => ({});',
      };
      return nextLoad(url, context);
    } });
  `;
    const child = spawn(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, bin],
      {
        cwd: serverRoot,
        env: {
          ...env,
          CARDIGAN_RUNTIME_MODE: "local",
          CARDIGAN_DATA_DIR: dataDir,
          CARDIGAN_MCP_HOST: "127.0.0.1",
          CARDIGAN_MCP_PORT: listener === "MCP" ? String(port) : "0",
          CARDIGAN_WEB_PORT: listener === "Web" ? String(port) : "0",
          CARDIGAN_LISTEN_RETRY_INTERVAL_MS: "10",
          CARDIGAN_LISTEN_RETRY_TIMEOUT_MS: "30",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: 1, signal: null });
      expect(stdout).not.toContain('"ready":true');
      expect(stderr).toContain(`端口 ${port} 被占用（EADDRINUSE）`);
      expect(stderr).toContain(
        `启动失败：等待 30 毫秒后，端口 ${port} 仍被占用（EADDRINUSE）。`,
      );
    } finally {
      child.kill();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
