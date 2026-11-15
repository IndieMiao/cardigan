import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeDeploymentDriver } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test.runIf(process.platform === "linux").each(["MCP", "Web"])(
  "real supervisor/role entries never start background while %s retries or fails",
  async (listener) => {
    const root = await mkdtemp(join(tmpdir(), "cg-dual-startup-"));
    const release = join(root, "release"),
      dataDir = join(root, "data"),
      bin = join(root, "bin");
    await mkdir(join(release, "apps/server/dist"), { recursive: true });
    await chmod(release, 0o755);
    await mkdir(join(dataDir, "central"), { recursive: true });
    await chmod(dataDir, 0o700);
    await mkdir(bin);
    for (const command of ["hc", "pnpm"])
      await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
    // Only the release wrapper is synthetic. It runs the built production entry,
    // including launch gate, host wiring, real listeners and all original loops.
    for (const entry of ["bin", "background-bin"])
      await writeFile(
        join(release, `apps/server/dist/${entry}.js`),
        `import(${JSON.stringify(new URL(`../dist/${entry}.js`, import.meta.url).href)});\n`,
      );
    await writeFile(join(root, "launch.yaml"), "providers: {}\nprofiles: {}\n");
    const git = (args: string[]) =>
      exec(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        {
          cwd: release,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git(["commit", "-m", "test: real role entry wrappers"]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git([
      "clone",
      "--bare",
      release,
      join(dataDir, "central/cardigan.git"),
    ]);
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    const mcp = await freePort(),
      web = await freePort();
    const occupied = createServer();
    const port = listener === "MCP" ? mcp : web;
    const occupy = () =>
      new Promise<void>((resolve) =>
        occupied.listen(port, "127.0.0.1", resolve),
      );
    const closePort = () =>
      new Promise<void>((resolve) => occupied.close(() => resolve()));
    const driver = new NodeDeploymentDriver({
      store,
      dataDir,
      config: {
        enabled: false,
        initial_release: release,
        initial_sha: sha,
        ready_timeout_ms: 3000,
        stop_timeout_ms: 3000,
        build_timeout_ms: 3000,
        poll_interval_ms: 1000,
        server_log_max_bytes: 65536,
        server_log_max_files: 2,
      },
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        CARDIGAN_CONFIG_DIR: root,
        CARDIGAN_RUNTIME_MODE: "local",
        CARDIGAN_HC_SESSION: "synthetic-startup",
        CARDIGAN_MCP_PORT: String(mcp),
        CARDIGAN_WEB_PORT: String(web),
        CARDIGAN_LISTEN_RETRY_INTERVAL_MS: "20",
        CARDIGAN_LISTEN_RETRY_TIMEOUT_MS: "1000",
      },
    });
    const state = async () =>
      JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
    let unlock: (() => Promise<void>) | undefined;
    try {
      await occupy();
      await expect(driver.initialize()).rejects.toThrow("did not become ready");
      expect((await state()).background).toBeUndefined();
      const logs = async () =>
        (
          await Promise.all(
            (
              await readdir(join(dataDir, "self-deploy/logs"))
            ).map((name) =>
              readFile(join(dataDir, "self-deploy/logs", name), "utf8"),
            ),
          )
        ).join("");
      expect(await logs()).not.toContain("[background]");
      expect(await logs()).toContain("EADDRINUSE");
      // Retrying the same pair is still gated. Releasing the listener lets the
      // production Web role bind, after which the background role may start.
      const starting = driver.initialize();
      await vi.waitFor(async () =>
        expect((await state()).process).toBeDefined(),
      );
      expect((await state()).background).toBeUndefined();
      await closePort();
      unlock = await starting;
      expect(await state()).toMatchObject({
        dual: true,
        ready: true,
        fence: 2,
        running: { sha },
        background: { pid: expect.any(Number) },
      });
      expect(await logs()).toContain('[web] {"ready":true');
      await vi.waitFor(async () =>
        expect(await logs()).toContain('[background] {"ready":true'),
      );
    } finally {
      await driver.stop();
      await driver.finishServerLogs();
      await unlock?.();
      if (occupied.listening) await closePort();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
