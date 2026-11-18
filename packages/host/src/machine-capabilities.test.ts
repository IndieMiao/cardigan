import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { refreshMachineObservations } from "./machine-capabilities.js";
import {
  BUILTIN_MACHINE_CAPABILITIES,
  loadMachineCapabilityCatalog,
  parseCapabilityVersion,
  parseMachineCapabilityCatalog,
} from "./machine-capability-catalog.js";
import {
  CAPABILITY_PROBE_SCRIPT,
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
  ])
    expect(() =>
      parseMachineCapabilityCatalog({ version: 1, capabilities: custom }),
    ).toThrow();
});

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
          _command: readonly string[],
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
