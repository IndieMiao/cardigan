import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Store } from "@cardigan/store";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test, vi } from "vitest";
import type { DeploymentController } from "./deployment.js";
import { parseDeploymentConfig } from "./deployment-config.js";
import type { NodeDeploymentDriver } from "./deployment-node.js";
import { executionOwner } from "./process-identity.js";

const LEGACY = "b69d15a771f057753863a652f6c88894aa81da67";
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../..", import.meta.url));

async function historicalModule(directory: string, name: string) {
  const { stdout } = await exec(
    "git",
    ["show", `${LEGACY}:packages/host/src/${name}.ts`],
    { cwd: repository },
  );
  // The exact historical control/adapter source runs in isolation. Leaf IO
  // helpers use the test build's compatible implementations, not a host install.
  const output = transpileModule(stdout, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  })
    .outputText.replace(
      /from "(\.[^"]+)"/g,
      (_, specifier: string) =>
        `from ${JSON.stringify(new URL(`../dist/${specifier.slice(2)}`, import.meta.url).href)}`,
    )
    .replace(
      /from "(@cardigan\/git-transport|yaml)"/g,
      (_, specifier: string) =>
        `from ${JSON.stringify(import.meta.resolve(specifier))}`,
    );
  const target = join(directory, `${name}.mjs`);
  await writeFile(target, output);
  return import(pathToFileURL(target).href);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test.runIf(process.platform === "linux")(
  "pinned legacy disabled watch still initializes/adopts current, detects exit and recovers current on restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-legacy-watch-"));
    const release = join(root, "release"),
      dataDir = join(root, "data");
    await mkdir(join(release, "apps/server/dist"), { recursive: true });
    await chmod(release, 0o755);
    await mkdir(join(dataDir, "central"), { recursive: true });
    await chmod(dataDir, 0o700);
    await writeFile(
      join(release, "apps/server/dist/bin.js"),
      `
    const net = require('node:net');
    const ports = [process.env.CARDIGAN_MCP_PORT, process.env.CARDIGAN_WEB_PORT].map(Number);
    let ready = 0;
    const sockets = ports.map(port => net.createServer().listen(port, '127.0.0.1', () => {
      if (++ready === 2) process.stdout.write(JSON.stringify({ready:true,deployment_fence:1,
        url:'http://127.0.0.1:'+ports[0],web_url:'http://127.0.0.1:'+ports[1]})+'\\n');
    }));
    process.on('SIGTERM', () => sockets.forEach(socket => socket.close()));
  `,
    );
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
    await git(["commit", "-m", "test: legacy server"]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git([
      "clone",
      "--bare",
      release,
      join(dataDir, "central/cardigan.git"),
    ]);
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    const oldAdapter = (await historicalModule(root, "deployment-node")) as {
      NodeDeploymentDriver: typeof NodeDeploymentDriver;
    };
    const oldControl = (await historicalModule(root, "deployment")) as {
      DeploymentController: typeof DeploymentController;
    };
    const options = {
      store,
      dataDir,
      config: {
        enabled: false,
        initial_release: release,
        initial_sha: sha,
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        build_timeout_ms: 3000,
        poll_interval_ms: 1000,
      },
      env: {
        PATH: process.env.PATH,
        CARDIGAN_MCP_PORT: String(await freePort()),
        CARDIGAN_WEB_PORT: String(await freePort()),
      },
    };
    let driver = new oldAdapter.NodeDeploymentDriver(options);
    let unlock: (() => Promise<void>) | undefined;
    const state = async () =>
      JSON.parse(
        await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
      );
    try {
      unlock = await driver.initialize();
      const first = await state();
      expect(first).toMatchObject({ current: { sha }, ready: true, fence: 1 });
      const check = vi.spyOn(driver, "checkServer");
      const main = vi.spyOn(driver, "main").mockResolvedValue("b".repeat(40));
      const build = vi.spyOn(driver, "build");
      const controller = new oldControl.DeploymentController(driver);
      await controller.tick();
      await controller.tick();
      expect(check).toHaveBeenCalledTimes(2);
      expect(main).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(executionOwner(first.process.pid)).toEqual(first.process);
      await unlock();
      unlock = undefined;
      driver = new oldAdapter.NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      expect((await state()).process).toEqual(first.process); // Adopt, despite enabled=false.
      process.kill(first.process.pid, "SIGKILL");
      await vi.waitFor(() =>
        expect(executionOwner(first.process.pid)).toBeUndefined(),
      );
      await expect(
        new oldControl.DeploymentController(driver).tick(),
      ).rejects.toThrow("主机 server 已退出");
      expect(await state()).toMatchObject({ current: { sha }, ready: false });
      expect((await state()).process).toBeUndefined();
      expect(
        store
          .getUpdates({ project_id: "cardigan" })
          .events.some(
            (e) =>
              e.type === "host_deployment_recorded" &&
              (e.payload as { summary?: string }).summary?.includes(
                "server_exited",
              ),
          ),
      ).toBe(true);
      await unlock();
      unlock = undefined;
      driver = new oldAdapter.NodeDeploymentDriver(options);
      unlock = await driver.initialize();
      const recovered = await state();
      expect(recovered).toMatchObject({
        current: { sha },
        running: { sha },
        ready: true,
      });
      expect(recovered.process).not.toEqual(first.process);
      await driver.stop();
      expect(executionOwner(recovered.process.pid)).toBeUndefined();
    } finally {
      await driver.stop();
      await driver.finishServerLogs();
      await unlock?.();
      store.close();
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
  15000,
);

test("new supervisor accepts the pinned legacy configuration without new topology keys; old rejects newer unknown keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-legacy-config-"));
  try {
    const old = (await historicalModule(root, "deployment-config")) as {
      parseDeploymentConfig: typeof parseDeploymentConfig;
    };
    const config = {
      enabled: false,
      initial_release: "/fixture/release",
      initial_sha: "a".repeat(40),
      ready_timeout_ms: 1000,
      stop_timeout_ms: 1000,
      build_timeout_ms: 1000,
      poll_interval_ms: 1000,
      server_log_max_bytes: 1024,
      server_log_max_files: 2,
    };
    expect(old.parseDeploymentConfig(config)).toMatchObject(config);
    expect(parseDeploymentConfig(config)).toMatchObject(config);
    // This field predates C-248 on current main; rolling the supervisor back
    // requires its own compatible backed-up YAML, not the newer config wholesale.
    expect(() =>
      old.parseDeploymentConfig({ ...config, evidence_wait_timeout_ms: 1000 }),
    ).toThrow();
    expect(
      parseDeploymentConfig({ ...config, evidence_wait_timeout_ms: 1000 })
        .enabled,
    ).toBe(false);
    expect(() =>
      parseDeploymentConfig({ ...config, background: {} }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
