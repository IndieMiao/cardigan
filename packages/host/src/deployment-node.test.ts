import { execFile, spawn } from "node:child_process";
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
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { gitSafetyArguments } from "@cardigan/git-transport";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { NodeDeploymentDriver } from "./deployment-node.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";
import { executionOwner } from "./process-identity.js";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test.runIf(process.platform === "linux")(
  "real child identity, ready ports, supervisor exclusivity and consistent SQLite backup",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-deployment-node-"));
    const release = join(root, "release");
    const dataDir = join(root, "data");
    await mkdir(join(release, "apps/server/dist"), { recursive: true });
    await mkdir(join(dataDir, "central"), { recursive: true });
    await chmod(release, 0o755);
    await chmod(dataDir, 0o700);
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    const git = (args: string[], cwd = release) =>
      exec(
        "git",
        [
          ...gitSafetyArguments,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
    let driver: NodeDeploymentDriver | undefined;
    let unlock: (() => Promise<void>) | undefined;
    try {
      await writeFile(
        join(release, "apps/server/dist/bin.js"),
        `
      const net = require('node:net');
      const ports = [process.env.CARDIGAN_MCP_PORT, process.env.CARDIGAN_WEB_PORT].map(Number);
      let ready = 0;
      const servers = ports.map(port => net.createServer().listen(port, '127.0.0.1', () => {
        if (++ready === 2) console.log(JSON.stringify({ready:true,deployment_fence:process.env.OMIT_DEPLOYMENT_FENCE ? 0 : 1,
          url:'http://127.0.0.1:'+ports[0], web_url:'http://127.0.0.1:'+ports[1]}));
      }));
      process.on('SIGTERM', () => servers.forEach(server => server.close()));
    `,
      );
      await git(["init", "-b", "main"]);
      await git(["add", "."]);
      await git(["commit", "-m", "test: initial server"]);
      const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await git([
        "clone",
        "--bare",
        release,
        join(dataDir, "central/cardigan.git"),
      ]);
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "pnpm"),
        '#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\necho "TOKEN=private-build-secret error TS6305: private-build-secret"\nexit 1\n',
        { mode: 0o700 },
      );
      const options = {
        store,
        dataDir,
        config: {
          enabled: true,
          initial_release: release,
          initial_sha: sha,
          ready_timeout_ms: 3000,
          stop_timeout_ms: 3000,
          build_timeout_ms: 5000,
          poll_interval_ms: 1000,
        },
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          BUILD_TOKEN: "parent-build-secret",
          CARDIGAN_MCP_PORT: String(await freePort()),
          CARDIGAN_WEB_PORT: String(await freePort()),
        },
      };
      driver = new NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      const state = JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      expect(await driver.ready()).toBe(true);
      const diagnostics = await readDeploymentDiagnostics(store, "cardigan");
      expect(diagnostics).toMatchObject({
        deployed_sha: sha,
        main_sha: sha,
        commits_behind: 0,
        fast_forward: true,
      });
      expect(JSON.stringify(diagnostics)).not.toContain(root);
      expect(await readDeploymentDiagnostics(store, "other")).toBeUndefined();
      await expect(
        new NodeDeploymentDriver(options).initialize(),
      ).rejects.toThrow();
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      await unlock();
      unlock = undefined;
      const check = acquireMergeCheckCapacity(
        store,
        "cardigan",
        "startup-check",
      );
      await expect(
        new NodeDeploymentDriver(options).initialize(),
      ).rejects.toThrow("Merge checks are active");
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      check();
      unlock = await new NodeDeploymentDriver(options).initialize();
      const adopted = JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
      expect(adopted.process).toEqual(state.process);
      const failedBuild = await driver.build(sha);
      expect(failedBuild).toEqual({
        log_tail: "TypeScript TS6305\nbuild: exit 1",
      });
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      await driver.stop();
      expect(executionOwner(state.process.pid)).toBeUndefined();
      await driver.backup();
      const backup = (await readdir(join(dataDir, "self-deploy"))).find(
        (name) => name.endsWith(".bak"),
      );
      expect(backup).toBeDefined();
      const db = new DatabaseSync(
        join(dataDir, "self-deploy", backup ?? "missing"),
        { readOnly: true },
      );
      try {
        expect(db.prepare("SELECT id FROM projects").all()).toEqual([
          { id: "cardigan" },
        ]);
      } finally {
        db.close();
      }
      await unlock();
      unlock = undefined;

      const unsupported = new NodeDeploymentDriver({
        ...options,
        config: { ...options.config, ready_timeout_ms: 100 },
        env: { ...options.env, OMIT_DEPLOYMENT_FENCE: "1" },
      });
      await expect(unsupported.initialize()).rejects.toThrow(
        "Initial server did not become ready",
      );
      expect(
        JSON.parse(
          await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
        ).process,
      ).toBeUndefined();

      // A live unrelated PID, even with a valid start time, must never be signalled.
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { cwd: root, stdio: "ignore" },
      );
      await new Promise<void>((resolve) => unrelated.once("spawn", resolve));
      try {
        const owner = executionOwner(unrelated.pid ?? 0);
        await writeFile(
          join(dataDir, "self-deploy/state.json"),
          JSON.stringify({
            current: { sha, release },
            running: { sha, release },
            process: owner,
            ready: true,
          }),
          { mode: 0o600 },
        );
        await expect(
          new NodeDeploymentDriver(options).initialize(),
        ).rejects.toThrow("identity mismatch");
        expect(executionOwner(unrelated.pid ?? 0)).toEqual(owner);
      } finally {
        unrelated.kill("SIGTERM");
        await new Promise<void>((resolve) =>
          unrelated.once("exit", () => resolve()),
        );
      }
    } finally {
      await driver?.stop();
      await unlock?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
