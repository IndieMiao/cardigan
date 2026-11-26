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
  symlink,
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
  knownDefaults,
  NodeDeploymentDriver,
  RunCapacityDeferred,
  recordDefault,
  supervisorCheckoutRoot,
} from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { startAssignmentById } from "./assignment.js";
import type { CliIo } from "./io.js";
import { runRoleCommand } from "./role.js";
import { runSelfDeployCommand } from "./self-deploy.js";

vi.mock("./assignment.js", () => ({ startAssignmentById: vi.fn() }));

test("invalid supervisor configuration creates one visible safe human notice without migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-invalid-deploy-"));
  const dataDir = join(root, "data");
  const store = Store.open({ dataDir });
  store.createProject({ id: "cardigan" });
  const version = store.schemaVersion();
  const stderr = vi.fn();
  const io: CliIo = {
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_CONFIG_DIR: root },
    cwd: root,
    platform: "linux",
    stdout: vi.fn(),
    stderr,
    signals: new EventEmitter(),
    spawnInherit: vi.fn(),
    captureCommand: vi.fn(),
  };
  try {
    await writeFile(
      join(root, "self-deploy.yaml"),
      "unknown: synthetic-private-value\n",
      { mode: 0o600 },
    );
    for (let i = 0; i < 2; i++)
      await expect(runSelfDeployCommand(["watch"], io)).rejects.toThrow(
        "无法安全读取",
      );
    const actions = store.uow.read((tx) => tx.human_actions.list("cardigan"));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      triage: "human",
      blocked_work_items: [],
    });
    expect(actions[0]?.instructions).toContain("无法安全解析部署配置");
    expect(JSON.stringify(actions)).not.toContain("synthetic-private-value");
    expect(stderr.mock.calls.flat().join("\n")).not.toContain(
      "synthetic-private-value",
    );
    expect(store.schemaVersion()).toBe(version);
    expect(io.spawnInherit).not.toHaveBeenCalled();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("C-772: check-upgrade is a host-only, read-only self-check of this checkout's launch file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-check-upgrade-"));
  const dataDir = join(root, "data");
  const out: string[] = [];
  const io: CliIo = {
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_CONFIG_DIR: root },
    cwd: root,
    platform: "linux",
    stdout: (line: string) => out.push(line),
    stderr: vi.fn(),
    signals: new EventEmitter(),
    spawnInherit: vi.fn(),
    captureCommand: vi.fn(),
  };
  try {
    await expect(
      runSelfDeployCommand(["check-upgrade"], {
        ...io,
        env: { ...io.env, CARDIGAN_TOKEN: "synthetic" },
      }),
    ).rejects.toThrow("Agent 不可调用");
    const checkout = await supervisorCheckoutRoot();
    const launch = join(root, "cardigan-selfdeploy.service");
    await writeFile(
      join(root, "supervisor-upgrade.yaml"),
      `enabled: true\nunit: cardigan-selfdeploy.service\nlaunch_file: ${launch}\n`,
      { mode: 0o600 },
    );
    const run = async () => {
      out.length = 0;
      const code = await runSelfDeployCommand(["check-upgrade"], io);
      return { code, text: out.join("\n") };
    };
    // C-767#73: the systemd unit is 0664, and it names a wrapper script
    // instead of the release directory.
    const unit =
      "[Service]\nExecStart=/home/x/cardigan-selfdeploy/selfdeploy-watch.sh\n";
    await writeFile(launch, unit, { mode: 0o600 });
    await chmod(launch, 0o664);
    let result = await run();
    expect(result.code).toBe(1);
    expect(result.text).toContain(`当前监督器目录：${checkout}`);
    expect(result.text).toContain("组或其他人可写（权限 0664）");
    expect(result.text).toContain("自检未通过");
    await chmod(launch, 0o644);
    result = await run();
    expect(result.code).toBe(1);
    expect(result.text).toContain("没有引用当前监督器目录");
    expect(result.text).toContain("RELEASE=");
    expect(await readFile(launch, "utf8")).toBe(unit);
    // Pointing at the file that names this checkout passes the launch check.
    await writeFile(launch, `RELEASE=${checkout}\n`);
    result = await run();
    expect(result.text).not.toContain("启动配置");
    // Nothing was opened, written or launched.
    await expect(readdir(dataDir)).rejects.toThrow();
    expect(io.spawnInherit).not.toHaveBeenCalled();
    expect(io.captureCommand).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["session", "blank-session", "hc", "pnpm", "git"])(
  "watch rejects missing %s before launching any process or applying migrations",
  async (missing) => {
    const root = await mkdtemp(join(tmpdir(), "cg-preflight-"));
    const dataDir = join(root, "data");
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    // Model the existing pre-split release's schema. Starting the supervisor
    // must not apply the new release migration while old service is still live.
    store.database.exec(
      "DROP TABLE context_samples; DROP TABLE upstream_probe_samples; DELETE FROM schema_version WHERE version >= 29",
    );
    store.close();
    try {
      for (const command of ["hc", "pnpm", "git"])
        if (command !== missing)
          await symlink(process.execPath, join(root, command));
      await writeFile(
        join(root, "self-deploy.yaml"),
        JSON.stringify({
          initial_release: root,
          initial_sha: "a".repeat(40),
          ready_timeout_ms: 1000,
          stop_timeout_ms: 1000,
          poll_interval_ms: 1000,
          build_timeout_ms: 1000,
        }),
        { mode: 0o600 },
      );
      const command = () => {
        throw new Error("Unexpected process launch");
      };
      await expect(
        runSelfDeployCommand(["watch"], {
          env: {
            PATH: root,
            CARDIGAN_DATA_DIR: dataDir,
            CARDIGAN_CONFIG_DIR: root,
            ...(missing === "session"
              ? {}
              : {
                  CARDIGAN_HC_SESSION:
                    missing === "blank-session" ? "  " : "synthetic-session",
                }),
          },
          cwd: root,
          platform: "linux",
          stdout: () => {},
          stderr: () => {},
          signals: new EventEmitter(),
          spawnInherit: command,
          captureCommand: async () => command(),
        }),
      ).rejects.toThrow(
        missing.endsWith("session")
          ? "必须显式设置 CARDIGAN_HC_SESSION"
          : `PATH 中缺少可执行命令 ${missing}`,
      );
      expect(await readdir(dataDir)).not.toContain("self-deploy");
      const unchanged = Store.open({ dataDir, migrate: false });
      try {
        expect(unchanged.schemaVersion()).toBe(28);
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
      await writeFile(join(root, "hc"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      watch = runSelfDeployCommand(["watch"], {
        env: {
          PATH: `${root}:${process.env.PATH}`,
          CARDIGAN_HC_SESSION: "synthetic-session",
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
      // The previous deployment recorded the default v1 equals.
      recordDefault(
        tx,
        "cardigan",
        "pm",
        {
          ...defaultRoleDefinition("pm", {
            harness: "codex",
            launch_profile_ref: "fixture",
          }),
          instructions: "Previous instructions",
        },
        "pack",
        "2026-01-01T00:00:00.000Z",
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
    // A matching default-pack baseline is not permission to publish a broken profile reference.
    await writeFile(
      join(root, "launch.yaml"),
      JSON.stringify({ profiles: { other: { harness: "codex", model: "m" } } }),
    );
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(start).not.toHaveBeenCalled();
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, "cardigan", "pm")?.version).toBe(1);
      const events = tx.events.listAfter("cardigan", undefined, 0);
      expect(
        events.some(
          (e) => e.type === "host_role_upgraded" || e.type === "role_updated",
        ),
      ).toBe(false);
      expect(JSON.stringify(events)).toContain("启动配置 fixture");
    });
    await writeFile(
      join(root, "launch.yaml"),
      JSON.stringify({
        profiles: { fixture: { harness: "codex", model: "m" } },
      }),
    );
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

test.each([
  {
    name: "a requirement-only change the older supervisor does not list",
    previous: [] as string[],
    instructions: undefined as string | undefined,
    cleared: false,
    changed: [] as string[],
    receipt: true,
    outcome: "upgrade",
  },
  {
    name: "requirements a project cleared, role listed as changed",
    previous: ["browser.chromium", "gpu"],
    instructions: "Earlier design director default",
    cleared: true,
    changed: ["design_director"],
    receipt: true,
    outcome: "conflict",
  },
  {
    name: "requirements a project cleared while another role changed",
    previous: ["browser.chromium", "gpu"],
    instructions: "Earlier design director default",
    cleared: true,
    changed: ["pm"],
    receipt: true,
    outcome: "kept",
  },
  {
    name: "no recorded default at all",
    previous: ["browser.chromium"],
    instructions: "Earlier design director default",
    cleared: false,
    changed: ["design_director"],
    receipt: false,
    outcome: "unverified",
  },
])(
  "post-deploy role sync judges only by the recorded defaults, the same on a rerun: $name",
  async ({ previous, instructions, cleared, changed, receipt, outcome }) => {
    const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-"));
    const dataDir = join(root, "data");
    const store = Store.open({ dataDir });
    vi.mocked(startAssignmentById).mockReset();
    const launch = { harness: "codex" as const, launch_profile_ref: "fixture" };
    const nextDefault = defaultRoleDefinition("design_director", launch);
    const previousDefault = {
      ...nextDefault,
      ...(instructions ? { instructions } : {}),
      required_capabilities: previous,
    };
    const io: CliIo = {
      env: {
        CARDIGAN_DATA_DIR: dataDir,
        CARDIGAN_CONFIG_DIR: root,
        CARDIGAN_DEPLOYMENT_CHANGED_ROLES: JSON.stringify(changed),
        // An older supervisor hashes the previous pack without machine requirements.
        CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES: JSON.stringify({
          design_director: deploymentRolePolicyHash({
            ...previousDefault,
            required_capabilities: [],
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
      await writeFile(
        join(root, "launch.yaml"),
        JSON.stringify({
          profiles: { fixture: { harness: "codex", model: "m" } },
        }),
      );
      store.createProject({ id: "cardigan" });
      store.uow.run((tx) => {
        writeRole(
          tx,
          "cardigan",
          { ...previousDefault, core_prompt: "", version: 1 },
          { mode: "add" },
        );
        // A receipt written before the record existed seeds it.
        if (receipt)
          tx.events.append("cardigan", {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence("cardigan"),
            type: "host_role_pack_published",
            actor: { kind: "system", project_id: "cardigan" },
            created_at: "2026-11-18T00:00:00.000Z",
            payload: {
              pack_hash: "previous-release",
              roles: {
                design_director: {
                  version: 1,
                  policy_hash: deploymentRolePolicyHash(previousDefault),
                  disposition: "matched",
                },
              },
            },
          });
        if (cleared)
          writeRole(
            tx,
            "cardigan",
            {
              ...previousDefault,
              required_capabilities: [],
              core_prompt: "",
              version: 2,
            },
            { mode: "update" },
          );
      });
      const before = store.uow.read((tx) =>
        getRoleVersion(tx, "cardigan", "design_director"),
      );
      const observe = () =>
        store.uow.read((tx) => {
          const events = tx.events.listAfter("cardigan", undefined, 0);
          const receipt = events
            .filter((e) => e.type === "host_role_pack_published")
            .at(-1)?.payload as {
            roles: Record<string, { disposition: string }>;
          };
          return {
            role: getRoleVersion(tx, "cardigan", "design_director"),
            disposition: receipt.roles.design_director?.disposition,
            upgrades: events.filter((e) => e.type === "host_role_upgraded")
              .length,
            deferrals: events
              .filter((e) => e.type === "host_role_upgrade_deferred")
              .map((e) => (e.payload as { notice: string }).notice),
            actions: tx.human_actions
              .list("cardigan")
              .map((a) => ({ status: a.status, instructions: a.instructions })),
          };
        });
      expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
      const first = observe();
      if (outcome === "upgrade") {
        expect(first.role).toMatchObject({
          version: 2,
          required_capabilities: ["browser.chromium"],
        });
        expect(first.upgrades).toBe(1);
        expect(first.actions).toEqual([]);
        expect(first.disposition).toBe("matched");
      } else {
        expect(first.role).toEqual(before);
        expect(first.upgrades).toBe(0);
        expect(first.disposition).toBe(
          outcome === "unverified" ? "unverified" : "conflict",
        );
        expect(first.actions).toEqual(
          outcome === "conflict"
            ? [
                {
                  status: "open",
                  instructions: expect.stringContaining("当前版本有手工改动"),
                },
              ]
            : [],
        );
        expect(first.deferrals).toEqual(
          outcome === "unverified"
            ? [expect.stringContaining("没有可核对的已记录默认包")]
            : [],
        );
      }
      expect(JSON.stringify(first.deferrals)).not.toContain("启动配置");
      // The same release run again, with no project write or confirmation in
      // between, reaches the same conclusion (V-3008).
      expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
      expect(observe()).toEqual(first);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("role upgrade --from-default records the default it wrote, so a deployment knows it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-cli-"));
  const dataDir = join(root, "data");
  const store = Store.open({ dataDir });
  vi.mocked(startAssignmentById).mockReset();
  const io: CliIo = {
    env: {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: root,
      CARDIGAN_DEPLOYMENT_CHANGED_ROLES: JSON.stringify(["design_director"]),
      CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES: "{}",
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
    await writeFile(
      join(root, "launch.yaml"),
      JSON.stringify({
        profiles: { fixture: { harness: "codex", model: "m" } },
      }),
    );
    store.createProject({ id: "cardigan" });
    const pack = defaultRoleDefinition("design_director", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    store.uow.run((tx) =>
      writeRole(
        tx,
        "cardigan",
        {
          ...pack,
          instructions: "Hand-edited director",
          core_prompt: "",
          version: 1,
        },
        { mode: "add" },
      ),
    );
    expect(
      await runRoleCommand(
        [
          "upgrade",
          "design_director",
          "--from-default",
          "--project",
          "cardigan",
        ],
        io,
      ),
    ).toBe(0);
    store.uow.read((tx) => {
      const written = getRoleVersion(tx, "cardigan", "design_director");
      expect(written?.version).toBe(2);
      expect(
        knownDefaults(tx, "cardigan")
          .get("design_director")
          ?.map((k) => k.policy_hash),
      ).toEqual([written && deploymentRolePolicyHash(written)]);
    });
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, "cardigan", "design_director")?.version).toBe(
        2,
      );
      expect(tx.human_actions.list("cardigan")).toEqual([]);
      const receipt = tx.events
        .listAfter("cardigan", undefined, 0)
        .filter((e) => e.type === "host_role_pack_published")
        .at(-1)?.payload as { roles: Record<string, { disposition: string }> };
      expect(receipt.roles.design_director?.disposition).toBe("matched");
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("C-613 post-deploy role sync also migrates customised roles in other projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-self-deploy-overlay-"));
  const dataDir = join(root, "data");
  const store = Store.open({ dataDir });
  const io: CliIo = {
    env: {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: root,
      CARDIGAN_DEPLOYMENT_CHANGED_ROLES: "[]",
      CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES: "{}",
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
    await writeFile(
      join(root, "launch.yaml"),
      JSON.stringify({
        profiles: { fixture: { harness: "codex", model: "m" } },
      }),
    );
    store.createProject({ id: "cardigan" });
    store.createProject({ id: "sensen" });
    const pack = defaultRoleDefinition("reviewer", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    // An earlier release recorded its reviewer default in sensen; the
    // project appended its own rule on top of it.
    const older = { ...pack, instructions: "Earlier reviewer default" };
    store.uow.run((tx) => {
      recordDefault(
        tx,
        "sensen",
        "reviewer",
        older,
        "pack",
        "2026-01-01T00:00:00.000Z",
      );
      writeRole(
        tx,
        "sensen",
        {
          ...older,
          core_prompt: "",
          instructions: `${older.instructions}\n\n时间点约束`,
          version: 1,
        },
        { mode: "add" },
      );
    });
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(await runSelfDeployCommand(["roles"], io)).toBe(0);
    expect(
      store.uow.read((tx) => getRoleVersion(tx, "sensen", "reviewer")),
    ).toMatchObject({
      version: 2,
      instructions: `${pack.instructions}\n\n时间点约束`,
      default_overlay: { append_instructions: "时间点约束" },
    });
    // Each project keeps its own record of the deployed pack.
    for (const project of ["cardigan", "sensen"])
      expect(
        store.uow.read((tx) => knownDefaults(tx, project).get("reviewer")),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            policy_hash: deploymentRolePolicyHash(pack),
          }),
        ]),
      );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
