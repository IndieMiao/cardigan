import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment } from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import {
  DeploymentServerUnavailable,
  deploymentRolePolicyHash,
  NodeDeploymentDriver,
  RunCapacityDeferred,
} from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { startAssignmentById } from "./assignment.js";
import type { CliIo } from "./io.js";
import { runSelfDeployCommand } from "./self-deploy.js";

vi.mock("./assignment.js", () => ({ startAssignmentById: vi.fn() }));

test.runIf(process.platform === "linux")(
  "normal watch shutdown retains the audit store and lock until rotating tail logs drain",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-tail-"));
    const dataDir = join(root, "data"),
      release = join(root, "release");
    const signals = new EventEmitter();
    const unblocked = Promise.withResolvers<void>();
    const writeBlocked = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const unlock = vi.fn();
    let watchError: unknown;
    let watch: Promise<{ value: number } | { error: unknown }> | undefined;
    try {
      await mkdir(join(release, "apps/server/dist"), { recursive: true });
      await chmod(release, 0o755);
      await mkdir(dataDir, { mode: 0o700 });
      const store = Store.open({ dataDir });
      store.createProject({ id: "cardigan" });
      store.close();
      const freePort = async () => {
        const server = createServer();
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No port");
        await new Promise<void>((done) => server.close(() => done()));
        return address.port;
      };
      const mcp = await freePort();
      let web = await freePort();
      while (web === mcp) web = await freePort();
      const ready = JSON.stringify({
        ready: true,
        deployment_fence: 1,
        url: `http://127.0.0.1:${mcp}`,
        web_url: `http://127.0.0.1:${web}`,
      });
      const initial = Buffer.from(`${ready}\nSTART\n`);
      const tail = Buffer.alloc(65536, 0xab);
      await writeFile(
        join(release, "apps/server/dist/bin.js"),
        `
      const net = require('node:net');
      let listening = 0;
      const servers = [${mcp}, ${web}].map(port => net.createServer().listen(port, '127.0.0.1', () => {
        if (++listening === 2) process.stdout.write(${JSON.stringify(initial.toString())});
      }));
      process.on('SIGTERM', () => {
        process.stdout.write(Buffer.alloc(65536, 0xab));
        servers.forEach(server => server.close());
      });
    `,
      );
      const exec = promisify(execFile);
      const git = (args: string[]) =>
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
      await git(["commit", "-m", "test: server exit tail"]);
      const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await mkdir(join(dataDir, "central"));
      await git([
        "clone",
        "--bare",
        release,
        join(dataDir, "central/cardigan.git"),
      ]);
      await writeFile(
        join(root, "self-deploy.yaml"),
        JSON.stringify({
          enabled: false,
          initial_release: release,
          initial_sha: sha,
          ready_timeout_ms: 3000,
          stop_timeout_ms: 3000,
          build_timeout_ms: 3000,
          poll_interval_ms: 1000,
          server_log_max_bytes: 4096,
          server_log_max_files: 40,
        }),
        { mode: 0o600 },
      );
      const originalInitialize = NodeDeploymentDriver.prototype.initialize;
      vi.spyOn(NodeDeploymentDriver.prototype, "initialize").mockImplementation(
        async function (this: NodeDeploymentDriver) {
          const releaseLock = await originalInitialize.call(this);
          return async () => {
            unlock();
            await releaseLock();
          };
        },
      );
      const originalStop = NodeDeploymentDriver.prototype.stop;
      vi.spyOn(NodeDeploymentDriver.prototype, "stop").mockImplementation(
        async function (this: NodeDeploymentDriver) {
          await originalStop.call(this);
          stopped.resolve();
        },
      );
      const close = vi.spyOn(Store.prototype, "close");
      watch = runSelfDeployCommand(["watch"], {
        env: {
          PATH: process.env.PATH,
          CARDIGAN_DATA_DIR: dataDir,
          CARDIGAN_CONFIG_DIR: root,
          CARDIGAN_MCP_PORT: String(mcp),
          CARDIGAN_WEB_PORT: String(web),
        },
        cwd: root,
        platform: "linux",
        signals,
        stdout: () => {},
        stderr: () => {},
        spawnInherit: () => {
          throw new Error("No harness launch");
        },
        captureCommand: async () => {
          throw new Error("No CLI command");
        },
      }).then(
        (value) => ({ value }),
        (error) => {
          watchError = error;
          return { error };
        },
      );
      const logs = join(dataDir, "self-deploy/logs");
      const readLogs = async () =>
        Buffer.concat(
          await Promise.all(
            (await readdir(logs))
              .sort()
              .map((name) => readFile(join(logs, name))),
          ),
        );
      await vi.waitFor(
        async () => {
          if (watchError) throw watchError;
          expect(signals.listenerCount("SIGTERM")).toBe(1);
          expect(await readLogs()).toEqual(initial);
        },
        { timeout: 5000 },
      );

      // Hold one actual log write in memory. The child must still stop, while
      // the CLI keeps audit and exclusivity resources alive until rotation ends.
      const probe = await open(join(root, "probe"), "w");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      await probe.close();
      const write = prototype.write;
      vi.spyOn(prototype, "write").mockImplementationOnce(async function (
        this: FileHandle,
        ...args
      ) {
        writeBlocked.resolve();
        await unblocked.promise;
        return Reflect.apply(write, this, args);
      });
      signals.emit("SIGTERM");
      await Promise.all([writeBlocked.promise, stopped.promise]);
      await new Promise<void>((done) => setImmediate(done));
      expect(
        JSON.parse(
          await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
        ).process,
      ).toBeUndefined();
      expect(close).not.toHaveBeenCalled();
      expect(unlock).not.toHaveBeenCalled();
      unblocked.resolve();
      expect(await watch).toEqual({ value: 0 });
      expect(close).toHaveBeenCalledOnce();
      expect(unlock).toHaveBeenCalledOnce();
      expect(await readLogs()).toEqual(Buffer.concat([initial, tail]));
      expect(await readdir(logs)).toHaveLength(17);
      const checked = Store.open({ dataDir });
      try {
        const audits = checked.uow.read((tx) =>
          tx.events
            .listAfter("cardigan", undefined, 0)
            .filter((event) => event.type === "host_server_log_recorded"),
        );
        expect(audits).toHaveLength(17);
        expect(
          audits.every(
            (event) =>
              (event.payload as { status: string }).status === "opened",
          ),
        ).toBe(true);
      } finally {
        checked.close();
      }
    } finally {
      unblocked.resolve();
      signals.emit("SIGTERM");
      await watch;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

test("watch propagates a lost server to its host service manager and releases the supervisor lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-exit-"));
  const dataDir = join(root, "data");
  const store = Store.open({ dataDir });
  store.createProject({ id: "cardigan" });
  store.close();
  const unlock = vi.fn(async () => {});
  const initialize = vi
    .spyOn(NodeDeploymentDriver.prototype, "initialize")
    .mockResolvedValue(unlock);
  const check = vi
    .spyOn(NodeDeploymentDriver.prototype, "checkServer")
    .mockRejectedValue(new Error("Server exited"));
  const signals = { on: vi.fn(), off: vi.fn() };
  const stderr = vi.fn();
  try {
    await writeFile(
      join(root, "self-deploy.yaml"),
      JSON.stringify({
        initial_release: root,
        initial_sha: "a".repeat(40),
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        build_timeout_ms: 1000,
        poll_interval_ms: 1000,
      }),
      { mode: 0o600 },
    );
    await expect(
      runSelfDeployCommand(["watch"], {
        env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_CONFIG_DIR: root },
        cwd: root,
        platform: "linux",
        stdout: () => {},
        stderr,
        signals,
        spawnInherit: () => {
          throw new Error("No real launch");
        },
        captureCommand: async () => {
          throw new Error("No real command");
        },
      }),
    ).rejects.toBeInstanceOf(DeploymentServerUnavailable);
    expect(check).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledOnce();
    expect(signals.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(signals.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    initialize.mockRestore();
    check.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("post-deploy starts the replacement Ops as host automation only when it has no Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-"));
  const dataDir = join(root, "data");
  const store = Store.open({ dataDir });
  const start = vi.mocked(startAssignmentById);
  start.mockReset();
  start.mockRejectedValueOnce(new RunCapacityDeferred("R-1", 1));
  const io: CliIo = {
    env: {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: root,
      CARDIGAN_DEPLOYMENT_CHANGED_ROLES: '["pm"]',
      CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES: JSON.stringify({
        pm: deploymentRolePolicyHash({
          ...defaultRoleDefinition("pm", {
            harness: "codex",
            launch_profile_ref: "fixture",
          }),
          instructions: "Previous instructions",
        }),
      }),
    },
    cwd: root,
    platform: "linux",
    stdout: () => {},
    stderr: () => {},
    signals: { on: () => {}, off: () => {} },
    spawnInherit: () => {
      throw new Error("No real launch");
    },
    captureCommand: async () => {
      throw new Error("No real command");
    },
  };
  try {
    await writeFile(
      join(root, "self-deploy.yaml"),
      JSON.stringify({
        initial_release: root,
        initial_sha: "a".repeat(40),
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        build_timeout_ms: 1000,
        poll_interval_ms: 1000,
      }),
      { mode: 0o600 },
    );
    store.createProject({ id: "cardigan" });
    store.uow.run((tx) => {
      writeRole(
        tx,
        "cardigan",
        {
          ...defaultRoleDefinition("pm", {
            harness: "codex",
            launch_profile_ref: "fixture",
          }),
          core_prompt: "",
          instructions: "Previous instructions",
          version: 1,
        },
        { mode: "add" },
      );
      tx.assignments.put("cardigan", {
        id: "A-50",
        scope: "standing",
        standing_mode: "ops",
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "fixture",
        created_at: "2026-01-01T00:00:00.000Z",
      } as Assignment);
    });
    for (const previous of [
      undefined,
      "not-json-private-value",
      "[]",
      JSON.stringify({ pm: "short-hash" }),
    ]) {
      await expect(
        runSelfDeployCommand(["roles"], {
          ...io,
          env: { ...io.env, CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES: previous },
        }),
      ).rejects.toThrow("上一默认版本指纹");
      expect(
        store.uow.read((tx) => getRoleVersion(tx, "cardigan", "pm")?.version),
      ).toBe(1);
      expect(start).not.toHaveBeenCalled();
    }
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      project_id: "cardigan",
      automatic: true,
    });
    const id = start.mock.calls[0]?.[0].assignment_id;
    if (!id) throw new Error("Expected replacement assignment");
    store.uow.run((tx) =>
      tx.runs.put("cardigan", {
        id: tx.ids.next("cardigan", "run"),
        assignment_id: id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "initial",
        status: "queued",
        role_version: 2,
        model: "fixture",
        agent_cli_version: "fixture",
        outcome: null,
        summary: "",
      }),
    );
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    await expect(
      runSelfDeployCommand(["roles"], {
        ...io,
        env: { ...io.env, CARDIGAN_TOKEN: "fixture-token" },
      }),
    ).rejects.toThrow("Agent 不可调用");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
