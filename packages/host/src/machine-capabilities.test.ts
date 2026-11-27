import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import * as herdr from "@cardigan/runtime-herdr";
import {
  readMachineObservations,
  recordAcceptedBrowserPath,
  Store,
} from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  ANDROID_DEVICE_PROBE_COMMAND,
  androidDeviceProvider,
} from "./android-device-provider.js";
import { refreshMachineObservations } from "./machine-capabilities.js";
import {
  BUILTIN_MACHINE_CAPABILITIES,
  loadMachineCapabilityCatalog,
  parseCapabilityVersion,
  parseMachineCapabilityCatalog,
} from "./machine-capability-catalog.js";
import {
  CAPABILITY_PROBE_SCRIPT,
  type CapabilityCommand,
  probeMachineCapability,
} from "./machine-capability-probe.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "machine-capabilities-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("catalog includes OS-specific probes and normalizes versions without retaining banners", () => {
  expect(BUILTIN_MACHINE_CAPABILITIES.map((c) => c.key)).toEqual([
    "harness.claude-code",
    "harness.codex",
    "harness.pi",
    "blender",
    "godot",
    "gpu.nvidia",
    "gpu.apple",
    "android.sdk",
    "android.emulator",
    "xcode",
    "ios.simulator",
    "docker",
    "node",
    "python",
    "browser.chromium",
  ]);
  expect(
    BUILTIN_MACHINE_CAPABILITIES.find((c) => c.key === "xcode")?.os,
  ).toEqual(["darwin"]);
  expect(
    BUILTIN_MACHINE_CAPABILITIES.find((c) => c.key === "gpu.nvidia")?.os,
  ).toEqual(["linux"]);
  for (const [output, version] of [
    ["v24.11.0", "24.11.0"],
    ["4.5.1.stable.official", "4.5.1"],
    ["Xcode 16.2\nBuild version fixture", "16.2"],
    ["logged in fixture-secret", null],
  ])
    expect(parseCapabilityVersion(output)).toBe(version);
});

test("private custom catalog cannot replace builtins or load unsafe files", () => {
  const root = temp(),
    env = { CARDIGAN_CONFIG_DIR: root },
    file = join(root, "machine-capabilities.yaml");
  expect(loadMachineCapabilityCatalog(env)).toEqual(
    BUILTIN_MACHINE_CAPABILITIES,
  );
  writeFileSync(
    file,
    "version: 1\ncapabilities:\n  lark-cli:\n    check: [lark-cli, auth, status]\n    version: [lark-cli, --version]\n",
    { mode: 0o600 },
  );
  expect(loadMachineCapabilityCatalog(env).at(-1)?.key).toBe("lark-cli");
  chmodSync(file, 0o644);
  expect(() => loadMachineCapabilityCatalog(env)).toThrow(
    "configuration invalid",
  );
  rmSync(file);
  symlinkSync("elsewhere", file);
  expect(() => loadMachineCapabilityCatalog(env)).toThrow(
    "configuration invalid",
  );
  for (const custom of [
    { node: { check: ["echo", "24.0"] } },
    { bad: { check: "shell command" } },
    { bad: { check: ["tool"], os: ["windows"] } },
    // C-813: device keys only come from the device listing.
    { "android.device": { check: ["true"] } },
    { "android.device.model.x": { check: ["true"] } },
  ])
    expect(() =>
      parseMachineCapabilityCatalog({ version: 1, capabilities: custom }),
    ).toThrow();
});

test.each([
  ["linux", "chromium-8/chrome-linux64/chrome"],
  ["linux", "chromium_headless_shell-8/chrome-linux/headless_shell"],
  ["darwin", "chromium-8/chrome-mac/Chromium.app/Contents/MacOS/Chromium"],
  [
    "darwin",
    "chromium-8/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
])(
  "%s Chromium probe prefers the literal configured registry (%s) over the Run PATH",
  (os, layout) => {
    const home = temp(),
      path = join(home, "bin"),
      registry = join(home, "registry $(false) [abc] '");
    const install = (file: string, version: string, code = 0) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `#!/bin/sh\n[ "$1" = --version ] || exit 1\necho 'Chromium ${version}'\nexit ${code}\n`,
        { mode: 0o700 },
      );
    };
    install(join(path, "chromium"), "2.0");
    const browser = join(registry, layout);
    install(browser, "152.1.2.3");
    const entry = parseMachineCapabilityCatalog(undefined, registry, os).find(
      (c) => c.key === "browser.chromium",
    );
    if (!entry) throw new Error("Missing browser probe");
    // Exercise the real worker protocol with a synthetic OS layout. PATH is isolated;
    // the wrapper still verifies the actual OS and restores the actual worker account.
    const python = execFileSync(
      "python3",
      ["-c", "import sys; print(sys.executable)"],
      { encoding: "utf8" },
    ).trim();
    const plan = entry.check;
    if (!("scopes" in plan)) throw new Error("Missing search plan");
    const run = () => {
      const output = execFileSync(
        python,
        [
          "-I",
          "-B",
          "-c",
          CAPABILITY_PROBE_SCRIPT,
          JSON.stringify({
            os: process.platform,
            argv: {
              ...plan,
              scopes: plan.scopes.map((s) =>
                s.kind === "cache"
                  ? { ...s, kind: "registry", value: join(home, s.value) }
                  : s,
              ),
            },
            timeout_ms: 1000,
          }),
        ],
        { env: { PATH: path }, encoding: "utf8" },
      );
      const result = JSON.parse(output);
      return result.ok ? entry.parseVersion(result.output) : null;
    };
    expect(run()).toBe("152.1.2.3");
    install(browser, "99.9", 1);
    expect(run()).toBe("2.0"); // Ignore the failed binary's banner.
    install(browser, "unknown"); // A successful exit without a version must not mask PATH.
    expect(run()).toBe("2.0");
    chmodSync(browser, 0o600);
    expect(run()).toBe("2.0");
    if (os === "linux") {
      rmSync(join(path, "chromium"));
      expect(run()).toBeNull();
      install(join(home, ".cache/ms-playwright", layout), "3.0");
      expect(run()).toBe("3.0");
    }
  },
);

test.each(["linux", "darwin"])(
  "refresh probes %s as the configured project worker, persists only safe proof, and revokes failures",
  async (os) => {
    const store = Store.open({ dataDir: temp() });
    try {
      store.createProject({ id: "a" });
      const machine = () => {
        const registered = store.uow.read((tx) =>
          tx.machines.get("a", "local"),
        );
        if (!registered) throw new Error("Missing fixture machine");
        return registered;
      };
      const initial = machine();
      store.uow.run((tx) => tx.machines.put("a", { ...initial, os }));
      const execution: ExecutionConfig = {
        mode: "agent-ssh",
        dataDir: "/fixture/controller",
        agentRoot: "/fixture/worker",
        machine: "project-a",
        user: "worker-a",
        identityFile: "/fixture/id",
        knownHostsFile: "/fixture/known",
      };
      const probe = vi.fn(
        async (
          _execution: ExecutionConfig,
          _os: string,
          _command: CapabilityCommand,
          _signal?: AbortSignal,
        ) => ({
          ok: true,
          output: "Fixture 4.7.1\ncredential-never-persisted",
        }),
      );
      const options = {
        store,
        project: "a",
        machine: "local",
        target: () => ({
          execution,
          machine: machine(),
        }),
        check: async () => ({ blockers: [], launch_enabled: true }),
        catalog: () =>
          parseMachineCapabilityCatalog({
            version: 1,
            capabilities: {
              "lark-cli": {
                check: ["lark-cli", "auth", "status"],
                version: ["lark-cli", "--version"],
              },
            },
          }),
        now: () => "2026-11-18T00:00:00.000Z",
        probe,
      };
      const first = await refreshMachineObservations(options);
      expect(first.health?.available).toBe(true);
      for (const [harness, binary] of [
        ["claude-code", "claude"],
        ["codex", "codex"],
        ["pi", "pi"],
      ]) {
        expect(probe).toHaveBeenCalledWith(
          execution,
          os,
          [binary, "--version"],
          undefined,
        );
        expect(first.capabilities).toContainEqual(
          expect.objectContaining({
            key: `harness.${harness}`,
            version: "4.7.1",
            available: true,
          }),
        );
      }
      expect(
        first.capabilities.find((c) => c.key === "lark-cli")?.version,
      ).toBe("4.7.1");
      expect(first.capabilities.some((c) => c.key === "xcode")).toBe(
        os === "darwin",
      );
      expect(first.capabilities.some((c) => c.key === "gpu.nvidia")).toBe(
        os === "linux",
      );
      expect(probe.mock.calls.every((call) => call[0] === execution)).toBe(
        true,
      );
      expect(
        JSON.stringify(
          store.database.prepare("SELECT * FROM machine_capabilities").all(),
        ),
      ).not.toContain("credential-never-persisted");
      probe.mockClear();
      const unhealthy = await refreshMachineObservations({
        ...options,
        check: async () => ({
          blockers: ["worker_account"],
          launch_enabled: false,
        }),
      });
      expect(unhealthy.capabilities).toEqual([]);
      expect(unhealthy.health?.blockers).toEqual(["worker_account"]);
      expect(probe).not.toHaveBeenCalled();
      probe.mockResolvedValue({ ok: false, output: "private-error" });
      expect((await refreshMachineObservations(options)).capabilities).toEqual(
        [],
      );
      expect(
        (
          await refreshMachineObservations({
            ...options,
            target: () => {
              throw new Error("private-path");
            },
          })
        ).health,
      ).toMatchObject({
        status: "failed",
        blockers: ["machine_observation_failed"],
      });
    } finally {
      store.close();
    }
  },
);

test("local probe uses its account HOME and never forwards controller credentials", async () => {
  vi.stubEnv("MCP_TOKEN", "fixture-token");
  vi.stubEnv("CARDIGAN_TOKEN", "fixture-token");
  const execution = { mode: "local" as const, dataDir: temp() };
  const result = await probeMachineCapability(execution, process.platform, [
    "python3",
    "-c",
    "import os,pwd; print(os.environ['HOME'] == pwd.getpwuid(os.getuid()).pw_dir); print('MCP_TOKEN' in os.environ or 'CARDIGAN_TOKEN' in os.environ)",
  ]);
  expect(result).toEqual({ ok: true, output: "True\nFalse\n" });
  expect(
    await probeMachineCapability(execution, process.platform, [
      "python3",
      "-c",
      "print('x'*20000)",
    ]),
  ).toEqual({ ok: false, output: "" });
  expect(
    await probeMachineCapability(execution, "unsupported", [
      "python3",
      "--version",
    ]),
  ).toEqual({ ok: false, output: "" });
});

test("only the bound worker variables reach the capability subprocess as literals", async () => {
  vi.stubEnv("MCP_TOKEN", "fixture-only");
  vi.stubEnv("UNBOUND", "controller-only");
  // Stub just the SSH hop; execute both the real probe and its child.
  using transport = vi
    .spyOn(herdr, "agentProcessCommand")
    .mockImplementation(async (_worker, [file, ...args]) => ({
      file: file as string,
      args,
    }));
  const env = {
    ANDROID_HOME: "/SDK's $(false) tools",
    ANDROID_ADB_SERVER_PORT: "15037",
  };
  const execution: ExecutionConfig = {
    mode: "agent-ssh",
    machine: "fixture",
    agentRoot: "/worker",
    dataDir: "/data",
    gid: 2001,
    identityFile: "/private/key",
    knownHostsFile: "/private/known",
    env,
  };
  const result = await probeMachineCapability(execution, process.platform, [
    "python3",
    "-c",
    "import json,os; print(json.dumps([os.getenv(k) for k in ('ANDROID_HOME', 'ANDROID_ADB_SERVER_PORT', 'MCP_TOKEN', 'UNBOUND')]))",
  ]);
  expect(transport).toHaveBeenCalledOnce();
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toEqual([
    env.ANDROID_HOME,
    env.ANDROID_ADB_SERVER_PORT,
    null,
    null,
  ]);
});

test("a late initialization failure cannot overwrite a newer successful observation", async () => {
  const store = Store.open({ dataDir: temp() });
  try {
    store.createProject({ id: "a" });
    const machine = store.uow.read((tx) => tx.machines.get("a", "local"));
    if (!machine) throw new Error("Missing fixture machine");
    const target = {
      execution: { mode: "local" as const, dataDir: "/fixture" },
      machine,
    };
    const options = {
      store,
      project: "a",
      machine: "local",
      target: () => target,
      check: async () => ({ blockers: [], launch_enabled: true }),
      catalog: () => [],
    };
    const initialization = Promise.withResolvers<never>();
    const check = vi.fn(options.check);
    const older = refreshMachineObservations({
      ...options,
      target: () => initialization.promise,
      check,
    });
    const newer = await refreshMachineObservations(options);
    initialization.reject(new Error("private-configuration-error"));
    expect(await older).toEqual(newer);
    expect(newer.health).toMatchObject({ status: "passed", available: true });
    expect(check).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test("iOS simulator requires an available iOS runtime", () => {
  const accepts = BUILTIN_MACHINE_CAPABILITIES.find(
    (c) => c.key === "ios.simulator",
  )?.acceptsOutput;
  expect(accepts?.('{"runtimes":[]}')).toBe(false);
  expect(
    accepts?.(
      JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
            isAvailable: false,
          },
        ],
      }),
    ),
  ).toBe(false);
  expect(
    accepts?.(
      JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
            isAvailable: true,
          },
        ],
      }),
    ),
  ).toBe(true);
  expect(accepts?.("malformed")).toBe(false);
});

test("worker-side timeout terminates a sleeping command without retaining its output", () => {
  const output = execFileSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      CAPABILITY_PROBE_SCRIPT,
      JSON.stringify({
        os: process.platform,
        argv: ["python3", "-c", "import time; time.sleep(1)"],
        timeout_ms: 20,
      }),
    ],
    { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } },
  );
  expect(JSON.parse(output)).toEqual({ ok: false, output: "" });
});

test("cancelling a running local probe drains its child process", async () => {
  const root = temp(),
    pidFile = join(root, "probe.pid"),
    controller = new AbortController();
  const pending = probeMachineCapability(
    { mode: "local", dataDir: root },
    process.platform,
    [
      "python3",
      "-c",
      "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(5)",
      pidFile,
    ],
    controller.signal,
  );
  try {
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    expect((await pending).ok).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await pending;
  }
});

test("a timed-out configured candidate leaves time for PATH and no surviving child", async () => {
  const dir = temp(),
    root = join(dir, "registry"),
    bin = join(dir, "bin"),
    pid = join(dir, "child.pid");
  const browser = join(root, "chromium-9/chrome-linux64/chrome");
  mkdirSync(dirname(browser), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    browser,
    `#!/bin/sh\necho $$ > '${pid}'\nexec /bin/sleep 30\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "chromium"),
    "#!/bin/sh\necho 'Chromium 150.2.3.4'\n",
    { mode: 0o700 },
  );
  const plan = parseMachineCapabilityCatalog(undefined, root, "linux").find(
    (c) => c.key === "browser.chromium",
  )?.check;
  if (!plan || !("scopes" in plan)) throw new Error("Missing browser plan");
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const result = await probeMachineCapability(
    { mode: "local", dataDir: dir },
    process.platform,
    plan,
  );
  expect(result).toEqual({ ok: true, output: "150.2.3.4" });
  expect(existsSync(pid)).toBe(true);
  expect(() => process.kill(Number(readFileSync(pid, "utf8")), 0)).toThrow();
});

test("a browser path change fences an in-flight result in either commit order without losing node", async () => {
  const dataDir = temp(),
    store = Store.open({ dataDir }),
    publisher = Store.open({ dataDir });
  try {
    store.createProject({ id: "a" });
    const machine = store.uow.read((tx) => tx.machines.get("a", "local"));
    if (!machine) throw new Error("Missing machine");
    const path = "/fixture/A",
      changed = "/fixture/B";
    recordAcceptedBrowserPath(publisher, path);
    const started = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const options = {
      store,
      project: "a",
      machine: "local",
      target: () => ({
        machine,
        execution: { mode: "local" as const, dataDir },
      }),
      check: async () => ({ blockers: [], launch_enabled: true }),
      browsersPath: () => path,
      probe: async (
        _execution: ExecutionConfig,
        _os: string,
        cmd: CapabilityCommand,
      ) => {
        if ("scopes" in cmd) {
          started.resolve();
          await finish.promise;
          return { ok: true, output: "Chromium 150.1" };
        }
        return { ok: cmd[0] === "node", output: "Node 24.1" };
      },
    };
    const first = refreshMachineObservations(options);
    await started.promise;
    recordAcceptedBrowserPath(publisher, changed);
    finish.resolve();
    const result = await first;
    expect(result.health?.available).toBe(true);
    expect(result.capabilities.map((c) => c.key)).toEqual(["node"]);
    recordAcceptedBrowserPath(publisher, path);
    expect(
      (await refreshMachineObservations(options)).capabilities.map(
        (c) => c.key,
      ),
    ).toEqual(["browser.chromium", "node"]);
    recordAcceptedBrowserPath(publisher, changed);
    expect(
      readMachineObservations(store, "a", "local").capabilities.map(
        (c) => c.key,
      ),
    ).toEqual(["node"]);
    const partial = await refreshMachineObservations({
      ...options,
      browsersPath: () => changed,
      probe: async () => ({
        ok: false,
        output: "private-error",
        attempted: 1,
        incomplete: true,
      }),
    });
    expect(partial.health?.capability_failures).toEqual([
      {
        key: "browser.chromium",
        search_locations: ["launch.yaml:browser.browsers_path"],
        search_incomplete: true,
      },
      // C-595: an unfinished built-in tool check keeps only fixed text.
      {
        key: "agent.attachment_tools",
        search_locations: [],
        reason: "附件助手检查未完成",
      },
    ]);
  } finally {
    publisher.close();
    store.close();
  }
});

test.each([
  ["worker helper 落后（已装 1，需要 2）"],
  ["worker helper 与当前部署的 SHA-256 不一致", "worker_helpers"],
])(
  "the post-deploy patrol opens one host_ops upgrade task per worker: %s",
  async (...blockers) => {
    const store = Store.open({ dataDir: temp() });
    try {
      store.createProject({ id: "a" });
      const machine = store.uow.run((tx) => {
        const local = tx.machines.get("a", "local");
        if (!local) throw new Error("fixture machine missing");
        const remote = {
          ...local,
          id: "remote",
          label: "Remote",
          herdr_machine: "remote",
        };
        tx.machines.put("a", remote);
        return remote;
      });
      const terminal = {
        target: machine.id,
        login: "admin",
        command: "fixture",
        expected_output: "OK",
        on_failure: "stop",
      };
      const options = {
        store,
        project: "a",
        machine: machine.id,
        stageUpgrade: vi
          .fn()
          .mockRejectedValueOnce(new Error("secret"))
          .mockResolvedValue(terminal),
        target: () => ({
          machine,
          execution: {
            mode: "agent-ssh" as const,
            dataDir: "/fixture",
            agentRoot: "/fixture/worker",
            machine: machine.id,
            gid: 123,
            identityFile: "/test/identity",
            knownHostsFile: "/test/hosts",
            target: {
              project_id: "a",
              machine_id: machine.id,
              session: "fixture",
              generation: "1",
              fingerprint: "pinned",
            },
          },
        }),
        check: async () => ({ blockers, launch_enabled: false }),
      };
      await refreshMachineObservations(options);
      const first = store.uow.read((tx) => tx.human_actions.list("a"))[0];
      expect(first?.terminal).toBeUndefined();
      expect(first?.instructions).toContain("暂存失败");
      expect(first?.instructions).not.toContain("secret");
      for (let i = 0; i < 2; i++)
        expect(
          (await refreshMachineObservations(options)).health,
        ).toMatchObject({
          // C-608: a same-protocol digest mismatch is only a warning.
          blockers: blockers.filter((b) => !b.includes("SHA-256")),
          available: false,
        });
      const actions = store.uow.read((tx) => tx.human_actions.list("a"));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        status: "open",
        triage: "host",
        host_operator: "host_ops",
        blocked_work_items: [],
      });
      expect(actions[0]).toMatchObject({
        id: first?.id,
        terminal,
        helper_upgrade: { machine_id: machine.id, binding: "pinned" },
      });
      for (const [name, sha] of Object.entries(workerHelperDigests()))
        expect(actions[0]?.instructions).toContain(`${sha}  ${name}`);
      const target = options.target();
      const { target: _removed, ...unbound } = target.execution;
      await refreshMachineObservations({
        ...options,
        target: () => ({ machine, execution: unbound }),
      });
      const unboundAction = store.uow.read((tx) =>
        tx.human_actions.list("a"),
      )[0];
      expect(unboundAction).toMatchObject({
        id: first?.id,
        status: "open",
        helper_upgrade: { machine_id: machine.id, binding: null },
      });
      expect(unboundAction?.terminal).toBeUndefined();
      expect(options.stageUpgrade).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
    }
  },
);

test("only consecutive preparations on one binding cool it down; expiry or success re-admits it", () => {
  const store = Store.open({ dataDir: temp() });
  let ms = Date.now();
  const clock = { now: () => new Date(ms).toISOString() };
  const outcome = (reason: string | null, target = "binding") =>
    store.uow.run((tx) =>
      workerPreparationOutcome(store, tx, "a", "remote", target, clock, reason),
    );
  const cooldown = () =>
    workerCooldown(store, "a", "remote", "binding", clock.now());
  try {
    store.createProject({ id: "a" });
    outcome("failed");
    outcome("failed");
    outcome(null);
    outcome("failed");
    outcome("failed");
    outcome("failed", "other");
    expect(cooldown()).toEqual({});
    outcome("failed");
    expect(cooldown()).toEqual({
      preparation_cooldown_until: new Date(ms + 1800000).toISOString(),
    });
    expect(store.uow.read((tx) => tx.human_actions.list("a"))).toMatchObject([
      { triage: "host", instructions: expect.stringContaining("连续 3 次") },
    ]);
    ms += 1800000;
    expect(cooldown()).toEqual({});
    outcome("failed");
    expect(cooldown()).toEqual({});
    outcome("failed");
    outcome("failed");
    outcome(null);
    expect(cooldown()).toEqual({});
  } finally {
    store.close();
  }
});

import { workerHelperDigests } from "./worker-helper-release.js";
import {
  workerCooldown,
  workerPreparationOutcome,
} from "./worker-maintenance.js";

test("C-708: a tool the probe cannot find leaves the machine's other capabilities and its launch eligibility intact", async () => {
  const store = Store.open({ dataDir: temp() });
  try {
    store.createProject({ id: "a" });
    const machine = () => {
      const registered = store.uow.read((tx) => tx.machines.get("a", "local"));
      if (!registered) throw new Error("Missing fixture machine");
      return registered;
    };
    const execution: ExecutionConfig = { mode: "local", dataDir: temp() };
    const installed = new Set(["node", "adb"]);
    const probe = vi.fn(
      async (_e: ExecutionConfig, _os: string, command: CapabilityCommand) => {
        const binary = Array.isArray(command) ? command[0] : undefined;
        return binary && installed.has(binary)
          ? { ok: true, output: `${binary} 24.11.0` }
          : { ok: false, output: "" };
      },
    );
    const catalog = () =>
      BUILTIN_MACHINE_CAPABILITIES.filter((c) =>
        [
          "node",
          "godot",
          "blender",
          "android.sdk",
          "android.emulator",
        ].includes(c.key),
      );
    const options = {
      store,
      project: "a",
      machine: "local",
      target: () => ({ execution, machine: machine() }),
      check: async () => ({ blockers: [], launch_enabled: true }),
      catalog,
      probe,
      now: () => "2026-11-25T00:00:00.000Z",
    };
    const first = await refreshMachineObservations(options);
    expect(first.health).toMatchObject({
      status: "passed",
      blockers: [],
      launch_enabled: true,
      available: true,
    });
    expect(first.capabilities.map((c) => c.key).sort()).toEqual([
      "android.sdk",
      "node",
    ]);
    // Installed on the device afterwards: the next check registers it too.
    installed.add("godot");
    const second = await refreshMachineObservations(options);
    expect(second.health).toMatchObject({ status: "passed", blockers: [] });
    expect(second.capabilities.map((c) => c.key).sort()).toEqual([
      "android.sdk",
      "godot",
      "node",
    ]);
  } finally {
    store.close();
  }
});

test("C-813: machine check asks each device provider; devices and their states are recorded, available (and held) ones become capabilities", async () => {
  const store = Store.open({ dataDir: temp() });
  try {
    store.createProject({ id: "a" });
    const machine = () => {
      const registered = store.uow.read((tx) => tx.machines.get("a", "local"));
      if (!registered) throw new Error("Missing fixture machine");
      return registered;
    };
    const execution: ExecutionConfig = { mode: "local", dataDir: temp() };
    let adb = true;
    let listing: { ok: boolean; output: string } = {
      ok: true,
      output: JSON.stringify({
        devices: [
          {
            serial: "WGC6R21609003324",
            state: "device",
            model: "MRR-W39",
            android: "12",
          },
          { serial: "R58N", state: "unauthorized" },
        ],
      }),
    };
    const probe = vi.fn(
      async (_e: ExecutionConfig, _os: string, command: CapabilityCommand) => {
        if (command === ANDROID_DEVICE_PROBE_COMMAND) return listing;
        return Array.isArray(command) && command[0] === "adb" && adb
          ? { ok: true, output: "Version 37.0.3" }
          : { ok: false, output: "" };
      },
    );
    const options = {
      store,
      project: "a",
      machine: "local",
      target: () => ({ execution, machine: machine() }),
      check: async () => ({ blockers: [], launch_enabled: true }),
      catalog: () =>
        BUILTIN_MACHINE_CAPABILITIES.filter((c) => c.key === "android.sdk"),
      probe,
      deviceProviders: [androidDeviceProvider],
      now: () => "2026-11-25T00:00:00.000Z",
    };
    const keys = (r: Awaited<ReturnType<typeof refreshMachineObservations>>) =>
      r.capabilities.map((c) => c.key).sort();
    const tablet = {
      type: "android.device",
      id: "WGC6R21609003324",
      state: "available",
      model: "MRR-W39",
      version: "12",
    };
    const first = await refreshMachineObservations(options);
    expect(first.health?.devices).toEqual([
      { type: "android.device", id: "R58N", state: "unauthorized" },
      tablet,
    ]);
    expect(keys(first)).toEqual([
      "android.device",
      "android.device.model.mrr-w39",
      "android.device:WGC6R21609003324",
      "android.sdk",
    ]);
    // Unplugged: gone from the list, and the machine loses the capability.
    listing = { ok: true, output: JSON.stringify({ devices: [] }) };
    const unplugged = await refreshMachineObservations(options);
    expect(unplugged.health?.devices).toEqual([]);
    expect(keys(unplugged)).toEqual(["android.sdk"]);
    // Plugged back in but the authorization was revoked.
    listing = {
      ok: true,
      output: JSON.stringify({
        devices: [{ serial: "WGC6R21609003324", state: "unauthorized" }],
      }),
    };
    const revoked = await refreshMachineObservations(options);
    expect(revoked.health?.devices).toEqual([
      { type: "android.device", id: "WGC6R21609003324", state: "unauthorized" },
    ]);
    expect(keys(revoked)).toEqual(["android.sdk"]);
    expect(revoked.health?.status).toBe("passed");
    // Available again, then held by a Run's own adb server: the listing no
    // longer sees it, but it stays as in use with the machine's capability.
    listing = {
      ok: true,
      output: JSON.stringify({
        devices: [
          { serial: "WGC6R21609003324", state: "device", model: "MRR-W39" },
        ],
      }),
    };
    await refreshMachineObservations(options);
    store.database
      .prepare(
        "INSERT INTO machine_device_leases (generation,machine,type,device,project,assignment_id,run_id,acquired_at) VALUES ('g','local','android.device','WGC6R21609003324','a','A-1','R-1','2026-11-25T00:00:00.000Z')",
      )
      .run();
    listing = { ok: true, output: JSON.stringify({ devices: [] }) };
    const held = await refreshMachineObservations(options);
    expect(held.health?.devices).toEqual([
      {
        type: "android.device",
        id: "WGC6R21609003324",
        state: "in_use",
        model: "MRR-W39",
      },
    ]);
    expect(keys(held)).toContain("android.device");
    // An unreadable listing is reported but does not fail the machine.
    listing = { ok: false, output: "" };
    const failed = await refreshMachineObservations(options);
    expect(failed.health).toMatchObject({ status: "passed", available: true });
    expect(failed.health?.capability_failures).toEqual([
      {
        key: "android.device",
        search_locations: [],
        reason: "无法列出安卓真机",
      },
    ]);
    // No adb on the machine: the provider is not asked at all.
    adb = false;
    probe.mockClear();
    const none = await refreshMachineObservations(options);
    expect(none.health?.devices).toBeUndefined();
    expect(
      probe.mock.calls.some(([, , c]) => c === ANDROID_DEVICE_PROBE_COMMAND),
    ).toBe(false);
  } finally {
    store.close();
  }
});
