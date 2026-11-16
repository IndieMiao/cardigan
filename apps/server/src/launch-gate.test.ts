import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

test.each(["bin", "background-bin"])(
  "production %s waits before DB IO, rejects orphan launch, then reports its role",
  async (entry) => {
    const root = mkdtempSync(join(tmpdir(), "cg-launch-gate-"));
    const dataDir = join(root, "data");
    writeFileSync(join(root, "launch.yaml"), "providers: {}\nprofiles: {}\n");
    const launch = () => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import assert from 'node:assert/strict';
          const write = process.stdout.write.bind(process.stdout);
          process.stdout.write = (chunk, ...args) => {
            if (String(chunk).includes('"ready":true')) {
              // Check the exact publication boundary, without depending on
              // whether the parent wins a scheduling race after stdout.
              assert.ok(process.listenerCount('SIGTERM') > 0);
              assert.ok(process.listenerCount('SIGINT') > 0);
            }
            return write(chunk, ...args);
          };
          await import(${JSON.stringify(new URL(`../dist/${entry}.js`, import.meta.url).href)});
          `,
        ],
        {
          env: {
            PATH: process.env.PATH,
            NODE_OPTIONS: process.env.NODE_OPTIONS,
            CARDIGAN_DATA_DIR: dataDir,
            CARDIGAN_CONFIG_DIR: root,
            CARDIGAN_SUPERVISED: "1",
            CARDIGAN_RUNTIME_MODE: "local",
            CARDIGAN_MCP_PORT: "0",
            CARDIGAN_WEB_PORT: "0",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      return { child, exited, output: () => stdout, errors: () => stderr };
    };
    const orphan = launch();
    let running: ReturnType<typeof launch> | undefined;
    try {
      orphan.child.disconnect();
      expect(await orphan.exited).toBe(1);
      expect(existsSync(dataDir)).toBe(false);
      running = launch();
      running.child.send("start");
      const target = running;
      await vi.waitFor(
        () => {
          expect(target.child.exitCode, target.errors()).toBeNull();
          expect(target.output()).toMatch(/"ready":true[^\n]*\n/);
        },
        { timeout: 10000 },
      );
      const ready = target
        .output()
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((line) => line.ready);
      expect(ready).toMatchObject({
        deployment_fence: 2,
        role: entry === "bin" ? "web" : "background",
      });
      expect(Boolean(ready.web_url)).toBe(entry === "bin");
      expect(existsSync(dataDir)).toBe(true);
      target.child.kill("SIGTERM");
      expect(await target.exited).toBe(0);
    } finally {
      for (const target of [orphan, running])
        if (
          target &&
          target.child.exitCode === null &&
          target.child.signalCode === null
        ) {
          target.child.kill("SIGKILL");
          await target.exited;
        }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
