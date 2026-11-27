import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANDROID_DEVICE_INIT_SCRIPT,
  ANDROID_DEVICE_PROBE_COMMAND,
  type CapabilityProbe,
  RuntimeTargets,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { roleConfig } from "../../../test-support/launch-fixture.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const capabilityProbe = vi.hoisted(() => vi.fn<CapabilityProbe>());
vi.mock("@cardigan/host", async (importOriginal) => {
  const host = await importOriginal<typeof import("@cardigan/host")>();
  return {
    ...host,
    checkRegisteredMachine: (options, create, source) =>
      host.checkRegisteredMachine(
        { ...options, probe: capabilityProbe },
        create,
        source,
      ),
  } satisfies typeof host;
});

const SERIAL = "WGC6R21609003324";
const DEVICE = `android.device:${SERIAL}`;
let dataDir: string;
let output: string[];
let errors: string[];
let io: CliIo;
let lock = "ok";

beforeEach(() => {
  lock = "ok";
  vi.spyOn(RuntimeTargets.prototype, "check").mockResolvedValue({
    ok: true,
    value: { machine_id: "local", blockers: [], launch_enabled: true },
  });
  capabilityProbe.mockReset().mockImplementation(async (_t, _os, command) => {
    if (command === ANDROID_DEVICE_PROBE_COMMAND)
      return {
        ok: true,
        output: JSON.stringify({
          devices: [
            {
              serial: SERIAL,
              state: "device",
              model: "MRR-W39",
              android: "12",
            },
          ],
        }),
      };
    if (Array.isArray(command) && command[4] === ANDROID_DEVICE_INIT_SCRIPT)
      return {
        ok: true,
        output: JSON.stringify(
          lock === "ok"
            ? { result: "ok", resolution: "1600x2560", version: "12" }
            : { result: "failed", step: "lock_screen" },
        ),
      };
    if (Array.isArray(command) && command[0] === "adb")
      return { ok: true, output: "Version 37.0.3" };
    return { ok: false, output: "" };
  });
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-machine-device-"));
  mkdirSync(join(dataDir, "config"), { mode: 0o700 });
  output = [];
  errors = [];
  io = {
    env: {
      CARDIGAN_RUNTIME_MODE: "local",
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: roleConfig(dataDir, "codex-agent"),
    },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

async function run(argv: string[], env: CliIo["env"] = io.env) {
  output = [];
  errors = [];
  return main(argv, { ...io, env });
}
const last = () => JSON.parse(output.join("\n"));
async function project(id: string) {
  expect(
    await run([
      "project",
      "create",
      id,
      "--code",
      id.toUpperCase().slice(0, 3),
    ]),
  ).toBe(0);
}
const humanActions = (p: string) => {
  const store = Store.open({ dataDir });
  try {
    return store.uow.read((tx) => tx.human_actions.list(p));
  } finally {
    store.close();
  }
};

test("C-817: machine device list / enable / disable / assign, with an immediate initialization", async () => {
  expect(await run(["init"])).toBe(0);
  await project("sensen");
  // A check discovers the tablet; it is listed as pending, not dispatchable.
  expect(await run(["machine", "check", "local", "--project", "sensen"])).toBe(
    0,
  );
  expect(await run(["machine", "device", "list", "local"])).toBe(0);
  expect(last()).toEqual([
    expect.objectContaining({
      machine: "local",
      type: "android.device",
      id: SERIAL,
      status: "pending",
      model: "MRR-W39",
      choices: ["sensen"],
      // C-818: the same row as the settings page, with what the check saw.
      state: "available",
    }),
  ]);
  expect(humanActions("sensen").map((h) => h.device_enablement?.phase)).toEqual(
    ["pending"],
  );

  // Initialization fails (lock credential set): the reason, exit non-zero.
  lock = "pin";
  expect(
    await run([
      "machine",
      "device",
      "enable",
      "local",
      DEVICE,
      "--project",
      "sensen",
    ]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("初始化失败：“关闭锁屏”没有成功");
  expect(last()).toMatchObject({ status: "failed", projects: ["sensen"] });
  // Retry: the only project of the machine is the default.
  lock = "ok";
  expect(
    await run([
      "machine",
      "device",
      "enable",
      "local",
      DEVICE,
      "--project",
      "sensen",
    ]),
  ).toBe(0);
  expect(last()).toMatchObject({
    status: "enabled",
    projects: ["sensen"],
    resolution: "1600x2560",
    version: "12",
  });
  expect(humanActions("sensen").map((h) => h.status)).toEqual(["done"]);
  expect(await run(["machine", "show", "local", "--project", "sensen"])).toBe(
    0,
  );

  // A second project registers the machine: assign needs explicit projects.
  await project("other");
  expect(
    await run([
      "machine",
      "device",
      "assign",
      "local",
      DEVICE,
      "--projects",
      "sensen,other",
      "--project",
      "sensen",
    ]),
  ).toBe(0);
  expect(last()).toMatchObject({
    status: "enabled",
    projects: ["sensen", "other"],
  });
  expect(
    await run([
      "machine",
      "device",
      "assign",
      "local",
      DEVICE,
      "--projects",
      "nobody",
      "--project",
      "sensen",
    ]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("机器没有登记给项目 nobody");

  expect(
    await run([
      "machine",
      "device",
      "disable",
      "local",
      DEVICE,
      "--project",
      "sensen",
    ]),
  ).toBe(0);
  expect(last()).toMatchObject({ status: "disabled" });
  // Enabled again: initialized before, no new initialization.
  capabilityProbe.mockClear();
  expect(
    await run([
      "machine",
      "device",
      "enable",
      "local",
      DEVICE,
      "--project",
      "sensen",
    ]),
  ).toBe(0);
  expect(last()).toMatchObject({ status: "enabled" });
  expect(capabilityProbe).not.toHaveBeenCalled();

  // Every request is audited globally.
  const store = Store.open({ dataDir });
  try {
    const audits = store.uow
      .read((tx) => tx.global_events.listAfter(0))
      .filter((e) => e.type === "machine_device_requested")
      .map((e) => e.payload as { request: string; status: string });
    expect(audits.map((a) => [a.request, a.status])).toEqual([
      ["enable", "initializing"],
      ["enable", "initializing"],
      ["assign", "enabled"],
      ["disable", "disabled"],
      ["enable", "enabled"],
    ]);
  } finally {
    store.close();
  }
});

test("C-817: machine device commands are human only and validate their arguments", async () => {
  expect(await run(["init"])).toBe(0);
  await project("sensen");
  for (const env of [
    { ...io.env, CARDIGAN_TOKEN: "x" },
    { ...io.env, MCP_TOKEN: "x" },
  ])
    expect(
      await run(["machine", "device", "enable", "local", DEVICE], env),
    ).not.toBe(0);
  expect(errors.join("\n")).toContain("仅限人类");
  expect(await run(["machine", "device", "wipe", "local", DEVICE])).not.toBe(0);
  expect(await run(["machine", "device", "enable", "local"])).not.toBe(0);
  expect(
    await run([
      "machine",
      "device",
      "enable",
      "local",
      SERIAL,
      "--project",
      "sensen",
    ]),
  ).not.toBe(0);
  expect(
    await run([
      "machine",
      "device",
      "disable",
      "local",
      DEVICE,
      "--projects",
      "sensen",
    ]),
  ).not.toBe(0);
  // Never seen on this machine: nothing to enable.
  expect(
    await run([
      "machine",
      "device",
      "enable",
      "local",
      DEVICE,
      "--project",
      "sensen",
    ]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("机器上没有登记这台设备");
});
