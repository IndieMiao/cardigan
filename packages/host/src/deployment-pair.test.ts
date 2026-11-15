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
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";
import { NodeDeploymentDriver } from "./deployment-node.js";
import { executionOwner } from "./process-identity.js";

const exec = promisify(execFile);
async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}
async function scripts(release: string, failingBackground = false) {
  await mkdir(join(release, "apps/server/dist"), { recursive: true });
  for (const role of ["web", "background"]) {
    await writeFile(
      join(
        release,
        `apps/server/dist/${role === "web" ? "bin" : "background-bin"}.js`,
      ),
      `
      const role = ${JSON.stringify(role)};
      // Do no work until the supervisor saved our incarnation.
      process.once('message', message => {
        if (message !== 'start') process.exit(9);
        if (${failingBackground} && role === 'background') process.exit(7);
        if (role === 'background') {
          process.on('message', () => {});
          process.stdout.write(JSON.stringify({ready:true, deployment_fence:2, role})+'\\n');
          process.on('SIGTERM', () => process.exit(0));
          return;
        }
        const net = require('node:net');
        const ports = [process.env.CARDIGAN_MCP_PORT, process.env.CARDIGAN_WEB_PORT].map(Number);
        let listening = 0;
        const sockets = ports.map(port => net.createServer().listen(port, '127.0.0.1', () => {
          if (++listening === 2) process.stdout.write(JSON.stringify({ready:true, deployment_fence:2, role,
            url:'http://127.0.0.1:'+ports[0], web_url:'http://127.0.0.1:'+ports[1]})+'\\n');
        }));
        process.on('SIGTERM', () => { sockets.forEach(socket => socket.close()); process.disconnect(); });
      });
    `,
    );
  }
}

test.runIf(process.platform === "linux")(
  "supervisor owns both identities, adopts/replaces the whole pair and rolls back a failed background",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-deploy-pair-"));
    const release = join(root, "release"),
      dataDir = join(root, "data"),
      bin = join(root, "bin");
    await scripts(release);
    await chmod(release, 0o755);
    await mkdir(join(dataDir, "central"), { recursive: true });
    await chmod(dataDir, 0o700);
    await mkdir(bin);
    for (const command of ["hc", "pnpm"])
      await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
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
    await git(["commit", "-m", "test: dual fixture"]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git([
      "clone",
      "--bare",
      release,
      join(dataDir, "central/cardigan.git"),
    ]);
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    const options = {
      store,
      dataDir,
      config: {
        enabled: true,
        initial_release: release,
        initial_sha: sha,
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        build_timeout_ms: 3000,
        poll_interval_ms: 1000,
        server_log_max_bytes: 4096,
        server_log_max_files: 3,
      },
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CARDIGAN_HC_SESSION: "synthetic-pair",
        CARDIGAN_MCP_PORT: String(await freePort()),
        CARDIGAN_WEB_PORT: String(await freePort()),
      },
    };
    let driver = new NodeDeploymentDriver(options);
    let unlock: (() => Promise<void>) | undefined;
    const state = async () =>
      JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
    try {
      unlock = await driver.initialize();
      const first = await state();
      expect(first).toMatchObject({
        dual: true,
        ready: true,
        fence: 2,
        running: { sha },
      });
      expect(first.process.pid).not.toBe(first.background.pid);
      await vi.waitFor(async () => {
        const directory = join(dataDir, "self-deploy/logs");
        const content = (
          await Promise.all(
            (
              await readdir(directory)
            ).map((name) => readFile(join(directory, name), "utf8")),
          )
        ).join("");
        expect(content).toContain('[web] {"ready":true');
        expect(content).toContain('[background] {"ready":true');
      });
      expect(executionOwner(first.process.pid)).toEqual(first.process);
      expect(executionOwner(first.background.pid)).toEqual(first.background);
      await unlock();
      unlock = undefined;
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      expect((await state()).background).toEqual(first.background);
      expect((await state()).process).toEqual(first.process);
      await unlock();
      unlock = undefined;
      await writeFile(
        join(dataDir, "self-deploy/state.json"),
        JSON.stringify({ ...first, background: first.process }),
        { mode: 0o600 },
      );
      await expect(
        new NodeDeploymentDriver(options).initialize(),
      ).rejects.toThrow("identity mismatch");
      expect(executionOwner(first.process.pid)).toEqual(first.process);
      expect(executionOwner(first.background.pid)).toEqual(first.background);
      await writeFile(
        join(dataDir, "self-deploy/state.json"),
        JSON.stringify(first),
        { mode: 0o600 },
      );
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      // A background failure must be visible despite healthy Web ports, and its
      // surviving Web identity must remain durable until the next supervisor stops it.
      process.kill(first.background.pid, "SIGKILL");
      await vi.waitFor(() =>
        expect(executionOwner(first.background.pid)).toBeUndefined(),
      );
      await expect(driver.checkServer()).rejects.toThrow("Server exited");
      expect((await state()).process).toEqual(first.process);
      expect((await state()).ready).toBe(false);
      await unlock();
      unlock = undefined;
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      let recovered = await state();
      expect(executionOwner(first.process.pid)).toBeUndefined();
      expect(recovered.ready).toBe(true);
      expect(recovered.process).not.toEqual(first.process);
      expect(recovered.background).not.toEqual(first.background);
      // Symmetric failure: retain and stop the background when only Web exits.
      const prior = recovered;
      process.kill(prior.process.pid, "SIGKILL");
      await vi.waitFor(() =>
        expect(executionOwner(prior.process.pid)).toBeUndefined(),
      );
      await expect(driver.checkServer()).rejects.toThrow("Server exited");
      expect((await state()).background).toEqual(prior.background);
      await unlock();
      unlock = undefined;
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      recovered = await state();
      expect(executionOwner(prior.background.pid)).toBeUndefined();
      expect(recovered.ready).toBe(true);
      // Exercise the real pair stop/start/ready adapter through the controller's
      // rollback protocol. Gate/build inputs are synthetic; no production main.
      const candidate = join(root, "candidate");
      await scripts(candidate, true);
      const target = "b".repeat(40);
      vi.spyOn(driver, "main").mockResolvedValue(target);
      vi.spyOn(driver, "isFastForward").mockResolvedValue(true);
      vi.spyOn(driver, "passedMergeGate").mockResolvedValue(true);
      vi.spyOn(driver, "build").mockResolvedValue({
        build: { sha: target, release: candidate },
        log_tail: "synthetic build",
      });
      vi.spyOn(driver, "migrationsChanged").mockResolvedValue(true);
      const records = vi.spyOn(driver, "record");
      await new DeploymentController(driver).tick();
      expect(records.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "rolled_back",
        ready: true,
        backup_file: expect.stringMatching(/^database-/),
      });
      const rolledBack = await state();
      expect(rolledBack).toMatchObject({
        current: { sha },
        running: { sha },
        dual: true,
        ready: true,
      });
      expect(executionOwner(recovered.process.pid)).toBeUndefined();
      expect(executionOwner(recovered.background.pid)).toBeUndefined();
      await driver.stop();
      expect(executionOwner(rolledBack.process.pid)).toBeUndefined();
      expect(executionOwner(rolledBack.background.pid)).toBeUndefined();
    } finally {
      await driver.stop();
      await unlock?.();
      await driver.finishServerLogs();
      store.close();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
  15000,
);
