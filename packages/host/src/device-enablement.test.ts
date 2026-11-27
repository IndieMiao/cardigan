import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelHumanAction,
  deviceActionKey,
  type HumanAction,
  reconcileDeviceAction,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import {
  ANDROID_DEVICE_HOLDER_SCRIPT,
  ANDROID_DEVICE_INIT_SCRIPT,
  ANDROID_DEVICE_PROBE_COMMAND,
  androidDeviceProvider,
} from "./android-device-provider.js";
import { requestDevice } from "./device-enablement.js";
import { DeviceRegistry, DeviceRequestError } from "./device-registry.js";
import { refreshMachineObservations } from "./machine-capabilities.js";
import { BUILTIN_MACHINE_CAPABILITIES } from "./machine-capability-catalog.js";
import type { CapabilityCommand } from "./machine-capability-probe.js";

const SERIAL = "WGC6R21609003324";
const TYPE = "android.device";
const at = "2026-11-27T00:00:00.000Z";
let dir: string, store: Store;
let listing: { ok: boolean; output: string };
let init: { ok: boolean; output: string };
let probe: ReturnType<typeof vi.fn>;
let emulator: boolean;

const plugged = (state = "device") => ({
  ok: true,
  output: JSON.stringify({
    devices: [{ serial: SERIAL, state, model: "MRR-W39", android: "12" }],
  }),
});
const result = (value: unknown) => ({
  ok: true,
  output: JSON.stringify(value),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-device-enable-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: "a" });
  listing = plugged();
  init = result({ result: "ok", resolution: "1600x2560", version: "12" });
  emulator = false;
  probe = vi.fn(
    async (_e: ExecutionConfig, _os: string, command: CapabilityCommand) => {
      if (command === ANDROID_DEVICE_PROBE_COMMAND) return listing;
      if (Array.isArray(command) && command[4] === ANDROID_DEVICE_INIT_SCRIPT)
        return init;
      if (Array.isArray(command) && command[0] === "emulator")
        return emulator
          ? { ok: true, output: "Android emulator version 35.1.4" }
          : { ok: false, output: "" };
      return Array.isArray(command) && command[0] === "adb"
        ? { ok: true, output: "Version 37.0.3" }
        : { ok: false, output: "" };
    },
  );
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function check(
  project = "a",
  extra: Partial<Parameters<typeof refreshMachineObservations>[0]> = {},
) {
  const machine = store.uow.read((tx) => tx.machines.get(project, "local"));
  if (!machine) throw new Error("missing machine");
  return refreshMachineObservations({
    store,
    project,
    machine: "local",
    target: () => ({
      execution: { mode: "local", dataDir: dir },
      machine,
    }),
    check: async () => ({ blockers: [], launch_enabled: true }),
    catalog: () =>
      BUILTIN_MACHINE_CAPABILITIES.filter((c) =>
        ["android.sdk", "android.emulator"].includes(c.key),
      ),
    probe: probe as never,
    deviceProviders: [androidDeviceProvider],
    now: () => at,
    ...extra,
  });
}
const actions = (project = "a"): HumanAction[] =>
  store.uow.read((tx) => tx.human_actions.list(project));
const open = (project = "a") =>
  actions(project).filter((h) => h.status === "open");
const keys = (r: Awaited<ReturnType<typeof check>>) =>
  r.capabilities.map((c) => c.key).filter((k) => k.startsWith(TYPE));
const registry = () => new DeviceRegistry(store);
const request = (req: "enable" | "disable" | "assign", projects?: string[]) =>
  requestDevice(
    store,
    {
      machine: "local",
      type: TYPE,
      id: SERIAL,
      request: req,
      ...(projects ? { projects } : {}),
    },
    { now: () => at },
  );
const initCalls = () =>
  probe.mock.calls.filter(
    ([, , c]) => Array.isArray(c) && c[4] === ANDROID_DEVICE_INIT_SCRIPT,
  );

test("C-817: a new device asks once in Needs You, preselecting the only project; enabling initializes it and the system closes the prompt", async () => {
  expect(keys(await check())).toEqual([]);
  const [prompt] = open();
  expect(prompt).toMatchObject({
    requested_by: "system",
    triage: "human",
    device_enablement: {
      machine_id: "local",
      type: TYPE,
      device_id: SERIAL,
      model: "MRR-W39",
      projects: ["a"],
      preselected: "a",
      steps: ["插电常亮", "关闭动画", "关闭锁屏"],
      phase: "pending",
    },
  });
  expect(prompt?.why_human).toBe("local 发现安卓真机 MRR-W39，给 a 用？");
  expect(prompt?.instructions).toContain(`设备编号：${SERIAL}`);
  expect(prompt?.instructions).toContain("不恢复出厂，不装卸其它应用");
  // Checking again does not ask again or initialize anything.
  await check();
  expect(actions()).toHaveLength(1);
  expect(initCalls()).toHaveLength(0);

  expect(request("enable", ["a"]).status).toBe("initializing");
  const enabled = await check();
  expect(initCalls().map(([, , c]) => (c as string[]).at(-1))).toEqual([
    SERIAL,
  ]);
  expect(registry().get("local", TYPE, SERIAL)).toMatchObject({
    status: "enabled",
    projects: ["a"],
    resolution: "1600x2560",
    version: "12",
  });
  expect(keys(enabled)).toEqual([
    TYPE,
    `${TYPE}.model.mrr-w39`,
    `${TYPE}:${SERIAL}`,
  ]);
  expect(actions()).toEqual([
    expect.objectContaining({
      status: "done",
      result: expect.objectContaining({
        text: "已启用安卓真机 MRR-W39（WGC6R21609003324），给 a 用；分辨率 1600x2560，系统版本 12。",
      }),
    }),
  ]);
  // Later checks do not run the initialization again.
  await check();
  expect(initCalls()).toHaveLength(1);
});

test("C-817: a failed initialization keeps the prompt with the reason and can be retried", async () => {
  await check();
  init = result({ result: "failed", step: "lock_screen" });
  request("enable", ["a"]);
  await check();
  expect(registry().get("local", TYPE, SERIAL)).toMatchObject({
    status: "failed",
    failure: expect.stringMatching(/^“关闭锁屏”没有成功：/u),
  });
  expect(keys(await check())).toEqual([]);
  const [failed] = open();
  expect(failed?.device_enablement).toMatchObject({
    phase: "failed",
    failure: expect.stringContaining("锁屏"),
  });
  expect(failed?.instructions).toContain("上次初始化失败：“关闭锁屏”没有成功");
  expect(actions()).toHaveLength(1);
  // Retry after the person removed the lock credential.
  init = result({ result: "ok", resolution: "1600x2560" });
  expect(request("enable").status).toBe("initializing");
  expect(open()[0]?.device_enablement?.phase).toBe("initializing");
  expect(open()[0]?.instructions).toContain("正在初始化");
  await check();
  expect(registry().get("local", TYPE, SERIAL)).toMatchObject({
    status: "enabled",
    version: "12",
  });
  expect(open()).toEqual([]);
});

test("C-817: no result, an unauthorized or missing device fail with a plain reason; a failed listing judges nothing", async () => {
  await check();
  request("enable", ["a"]);
  init = { ok: false, output: "" };
  await check();
  expect(registry().get("local", TYPE, SERIAL)?.failure).toBe(
    "初始化没有返回结果：检查机器连接后重试",
  );
  request("enable");
  listing = plugged("unauthorized");
  await check();
  expect(registry().get("local", TYPE, SERIAL)?.failure).toContain("授权");
  request("enable");
  listing = { ok: false, output: "" };
  await check();
  expect(registry().get("local", TYPE, SERIAL)?.status).toBe("initializing");
  listing = result({ devices: [] });
  await check();
  expect(registry().get("local", TYPE, SERIAL)?.failure).toContain(
    "没有看到这台设备",
  );
  expect(initCalls()).toHaveLength(1);
});

test("C-833: a device another adb server holds fails naming that server's port and session", async () => {
  await check();
  request("enable", ["a"]);
  listing = result({ devices: [] });
  let held: number | null = 5137;
  const base = probe.getMockImplementation();
  const asked: string[][] = [];
  probe.mockImplementation(
    async (e: ExecutionConfig, os: string, command: CapabilityCommand) => {
      if (
        Array.isArray(command) &&
        command[4] === ANDROID_DEVICE_HOLDER_SCRIPT
      ) {
        asked.push(command.slice(5));
        return result({ port: held });
      }
      return base?.(e, os, command);
    },
  );
  const adbHolders = async () =>
    [
      { port: 15100, kind: "slot", sessions: ["SEN-A-12"] },
      { port: 5137, kind: "legacy", sessions: ["SEN-A-634", "SEN-A-602"] },
      { port: 5037, kind: "other", sessions: [] },
    ] as const;
  await check("a", { adbHolders });
  expect(asked).toEqual([[SERIAL, "[15100,5137,5037]"]]);
  expect(registry().get("local", TYPE, SERIAL)).toMatchObject({
    status: "failed",
    failure:
      "设备被端口 5137 上的旧 adb 服务占用，可能属于切换前起的会话 SEN-A-634、SEN-A-602：系统巡检会让它放开 USB 设备，几分钟后重试",
  });
  expect(open()[0]?.device_enablement?.failure).toContain("5137");
  request("enable");
  held = 15100;
  await check("a", { adbHolders });
  expect(registry().get("local", TYPE, SERIAL)?.failure).toBe(
    "设备被端口 15100 上的 adb 服务占用，属于会话 SEN-A-12：等这个 Run 结束、系统关掉它的 adb 服务后重试",
  );
  request("enable");
  held = 5037;
  await check("a", { adbHolders });
  expect(registry().get("local", TYPE, SERIAL)?.failure).toBe(
    "设备被端口 5037 上的 adb 服务占用，不属于系统登记的会话：在机器上执行 adb -P 5037 kill-server 后重试",
  );
  // Nobody holds it: the plain reason stays.
  request("enable");
  held = null;
  await check("a", { adbHolders });
  expect(registry().get("local", TYPE, SERIAL)?.failure).toContain(
    "没有看到这台设备",
  );
});

test("C-817/C-832: a shared machine asks once without preselecting; the initialization runs as a chosen project's account, once", async () => {
  store.createProject({ id: "b" });
  await check("a");
  await check("b");
  // C-832: one prompt for the device, in the machine's first project.
  expect(open("b")).toEqual([]);
  expect(open("a")).toHaveLength(1);
  const [prompt] = open("a");
  expect(prompt?.device_enablement).toMatchObject({ projects: ["a", "b"] });
  expect(prompt?.device_enablement?.preselected).toBeUndefined();
  expect(prompt?.device_enablement?.chosen).toBeUndefined();
  expect(prompt?.why_human).toBe("local 发现安卓真机 MRR-W39，给哪些项目用？");
  expect(() => request("enable", ["c"])).toThrow(DeviceRequestError);
  expect(() => request("enable", [])).toThrow(DeviceRequestError);
  // Only b's account sees the device: b initializes it.
  listing = plugged("unauthorized");
  await check("a");
  listing = plugged();
  await check("b");
  expect(request("enable", ["a", "b"]).init_project).toBe("b");
  expect(open("a")[0]?.device_enablement).toMatchObject({
    phase: "initializing",
    chosen: ["a", "b"],
  });
  expect(open("b")).toEqual([]);
  await check("a");
  expect(initCalls()).toHaveLength(0);
  await check("b");
  expect(initCalls()).toHaveLength(1);
  // Both prompts are closed once it is enabled.
  expect(open("a")).toEqual([]);
  expect(open("b")).toEqual([]);
  // While initializing, a second enable is refused; the claim is single.
  request("disable");
  expect(request("enable").status).toBe("enabled");
});

/** A prompt raised per project before C-832: a copy of a's in `project`. */
function legacyPrompt(project: string) {
  const [source] = open("a");
  if (!source?.device_enablement) throw new Error("missing prompt");
  store.uow.run((tx) =>
    persistEffect(
      tx,
      project,
      unwrap(
        reconcileDeviceAction(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          {
            key: deviceActionKey("enable", "local", TYPE, SERIAL),
            open: {
              instructions: source.instructions,
              why_human: source.why_human,
              expected_return: source.expected_return,
              device_enablement: source.device_enablement,
              reopen_key: "legacy",
            },
          },
          { ids: tx.ids, clock: { now: () => at } },
        ),
      ),
    ),
  );
  const [legacy] = open(project);
  if (!legacy) throw new Error("missing legacy prompt");
  return legacy;
}

/** The owner closes a prompt themselves. */
function dismiss(project: string, id: HumanAction["id"]) {
  store.uow.run((tx) =>
    persistEffect(
      tx,
      project,
      unwrap(
        cancelHumanAction(
          loadCommandState(tx, project),
          { kind: "human", project_id: project },
          { human_action_id: id, reason: "先不用" },
          { ids: tx.ids, clock: { now: () => at } },
        ),
      ),
    ),
  );
}

test("C-832: a new device prompts only in the machine's first project, whichever project's check saw it", async () => {
  store.createProject({ id: "b" });
  await check("b");
  expect(open("b")).toEqual([]);
  expect(open("a").map((h) => h.device_enablement?.projects)).toEqual([
    ["a", "b"],
  ]);
  await check("a");
  await check("b");
  expect(actions("a")).toHaveLength(1);
  expect(actions("b")).toEqual([]);
});

test("C-832: per-project prompts raised before: answering one closes the others; the answered one stays and finishes", async () => {
  store.createProject({ id: "b" });
  await check("a");
  const legacy = legacyPrompt("b");
  // Checks keep both old prompts in step while nobody answered.
  await check("b");
  expect(open("a")).toHaveLength(1);
  expect(open("b").map((h) => h.id)).toEqual([legacy.id]);
  requestDevice(
    store,
    {
      machine: "local",
      type: TYPE,
      id: SERIAL,
      request: "enable",
      projects: ["a", "b"],
    },
    { now: () => at },
    { via: "workbench", project_id: "b" },
  );
  expect(open("a")).toEqual([]);
  expect(actions("a")[0]).toMatchObject({
    status: "cancelled",
    cancellation: expect.objectContaining({
      reason: "同一台设备已在 b 的提示里处理",
      source: "device_rechecked",
    }),
  });
  expect(open("b")[0]).toMatchObject({
    id: legacy.id,
    device_enablement: { phase: "initializing", chosen: ["a", "b"] },
  });
  await check("a");
  expect(open("a")).toEqual([]);
  await check("b");
  expect(registry().get("local", TYPE, SERIAL)?.status).toBe("enabled");
  expect(actions("a")).toHaveLength(1);
  expect(actions("b")).toEqual([
    expect.objectContaining({ id: legacy.id, status: "done" }),
  ]);
});

test("C-832: a prompt a person dismissed after the merge does not come back in another project in the same state", async () => {
  store.createProject({ id: "b" });
  await check("a");
  const legacy = legacyPrompt("b");
  init = result({ result: "failed", step: "lock_screen" });
  requestDevice(
    store,
    {
      machine: "local",
      type: TYPE,
      id: SERIAL,
      request: "enable",
      projects: ["a", "b"],
    },
    { now: () => at },
    { via: "workbench", project_id: "b" },
  );
  await check("a");
  expect(open("b")[0]?.device_enablement?.phase).toBe("failed");
  expect(open("a")).toEqual([]);
  dismiss("b", legacy.id);
  await check("a");
  await check("b");
  expect(open("a")).toEqual([]);
  expect(open("b")).toEqual([]);
  // A new state asks again, in the machine's first project.
  request("enable");
  expect(open("a").map((h) => h.device_enablement?.phase)).toEqual([
    "initializing",
  ]);
  expect(open("b")).toEqual([]);
});

test("C-832: dismissing one old per-project prompt leaves the other project's prompt", async () => {
  store.createProject({ id: "b" });
  await check("a");
  const legacy = legacyPrompt("b");
  dismiss("b", legacy.id);
  await check("a");
  await check("b");
  expect(open("a")).toHaveLength(1);
  expect(open("b")).toEqual([]);
  // A CLI answer (no project) keeps the machine's first project's prompt.
  request("enable", ["b"]);
  expect(open("a")[0]?.device_enablement).toMatchObject({
    phase: "initializing",
    chosen: ["b"],
  });
  expect(open("b")).toEqual([]);
});

test("C-817: disabling closes the prompt and stops dispatch; a disable during initialization wins", async () => {
  await check();
  request("enable", ["a"]);
  const reg = registry();
  const claim = reg.claimInit("local", TYPE, SERIAL, "a", at);
  expect(claim).toBeDefined();
  // Another check cannot claim the same initialization meanwhile.
  expect(reg.claimInit("local", TYPE, SERIAL, "a", at)).toBeUndefined();
  expect(() => request("enable")).toThrow("设备正在初始化");
  request("disable");
  expect(
    reg.finishInit("local", TYPE, SERIAL, claim as string, { ok: true }, at),
  ).toBe(false);
  expect(reg.get("local", TYPE, SERIAL)?.status).toBe("disabled");
  expect(keys(await check())).toEqual([]);
  expect(actions()).toEqual([
    expect.objectContaining({
      status: "cancelled",
      cancellation: expect.objectContaining({ source: "device_rechecked" }),
    }),
  ]);
});

function queue(n: number, capabilities: string[]) {
  const item = fixture().work_items[0];
  if (!item) throw new Error("missing item");
  const owner = assignment(n);
  store.uow.run((tx) => {
    tx.work_items.put("a", {
      ...item,
      id: owner.work_item_id,
      requirements: { capabilities },
    });
    tx.assignments.put("a", owner);
    tx.runs.put("a", { ...run(n), status: "queued" });
  });
  return item.card_id;
}

test("C-817: an enabled device that drops out reminds only while queued work waits on it, and the reminder closes when it is back", async () => {
  await check();
  request("enable", ["a"]);
  await check();
  const reminders = () =>
    open().filter((h) => h.instructions.includes("在等它"));
  // Unplugged, nothing waiting: no reminder.
  listing = result({ devices: [] });
  await check();
  expect(open()).toEqual([]);
  // Work waits on it: one reminder naming the card.
  const card = queue(1, [TYPE]);
  await check();
  expect(reminders()).toHaveLength(1);
  expect(reminders()[0]?.instructions).toContain(
    `local 上的安卓真机 MRR-W39（${SERIAL}）已拔掉或看不到，${card} 的工作在等它`,
  );
  // The authorization dropped instead: same reminder, updated reason.
  listing = plugged("unauthorized");
  await check();
  expect(reminders()).toHaveLength(1);
  expect(reminders()[0]?.instructions).toContain("掉了授权");
  // Back: closed by the system.
  listing = plugged();
  await check();
  expect(reminders()).toEqual([]);
  expect(actions().filter((h) => h.status === "cancelled")).toHaveLength(1);
  // Work that does not need it never reminds (emulator only).
  store.uow.run((tx) =>
    tx.runs.put("a", { ...run(1), status: "completed" } as never),
  );
  queue(2, ["android.emulator"]);
  listing = result({ devices: [] });
  await check();
  expect(reminders()).toEqual([]);
});

test("C-817: an assign during an initialization keeps its claim; an initialization nobody could run fails after the deadline", async () => {
  await check();
  request("enable", ["a"]);
  const reg = registry();
  const claim = reg.claimInit("local", TYPE, SERIAL, "a", at);
  expect(claim).toBeDefined();
  expect(request("assign", ["a"]).status).toBe("initializing");
  expect(reg.claimInit("local", TYPE, SERIAL, "a", at)).toBeUndefined();
  expect(
    reg.finishInit("local", TYPE, SERIAL, claim as string, { ok: true }, at),
  ).toBe(true);
  expect(reg.get("local", TYPE, SERIAL)?.status).toBe("enabled");

  // Initializing for over ten minutes, never claimed: failed with a reason.
  request("disable");
  store.database
    .prepare("UPDATE machine_devices SET initialized_at=NULL")
    .run();
  request("enable");
  const later = new Date(Date.parse(at) + 11 * 60_000).toISOString();
  expect(
    reg.expireInits(new Date(Date.parse(at) + 9 * 60_000).toISOString()),
  ).toEqual([]);
  // A recent claim (a check is running it) is not expired.
  reg.claimInit("local", TYPE, SERIAL, "a", later);
  expect(reg.expireInits(later)).toEqual([]);
  store.database
    .prepare("UPDATE machine_devices SET init_started_at=NULL")
    .run();
  expect(reg.expireInits(later)).toEqual(["local"]);
  expect(reg.get("local", TYPE, SERIAL)).toMatchObject({
    status: "failed",
    failure: expect.stringContaining("一直没能列出这台设备"),
  });
});

test("C-817: a failed listing is not taken for an unplugged device", async () => {
  await check();
  request("enable", ["a"]);
  await check();
  queue(1, [TYPE]);
  listing = { ok: false, output: "" };
  await check();
  expect(open().filter((h) => h.instructions.includes("在等它"))).toEqual([]);
});

test("C-827: a dropped device reminds queued android.any work only while the machine has no available emulator", async () => {
  await check();
  request("enable", ["a"]);
  await check();
  const reminders = () =>
    open().filter((h) => h.instructions.includes("在等它"));
  const card = queue(1, ["android.any"]);
  // An emulator is available: the work can still be dispatched, no reminder.
  emulator = true;
  listing = result({ devices: [] });
  const withEmulator = await check();
  expect(withEmulator.capabilities.map((c) => c.key)).toContain(
    "android.emulator",
  );
  expect(reminders()).toEqual([]);
  // No emulator: the device was its only way out, so it reminds like a
  // device requirement does.
  emulator = false;
  await check();
  expect(reminders()).toHaveLength(1);
  expect(reminders()[0]?.instructions).toContain(
    `local 上的安卓真机 MRR-W39（${SERIAL}）已拔掉或看不到，${card} 的工作在等它`,
  );
  // The emulator comes back: closed, nothing waits on the device any more.
  emulator = true;
  await check();
  expect(reminders()).toEqual([]);
  expect(actions().filter((h) => h.status === "cancelled")).toHaveLength(1);
});

test("C-827: emulator-only and device-only work keep their reminders whether or not an emulator is available", async () => {
  await check();
  request("enable", ["a"]);
  await check();
  const reminders = () =>
    open().filter((h) => h.instructions.includes("在等它"));
  queue(1, ["android.emulator"]);
  listing = result({ devices: [] });
  for (const e of [false, true]) {
    emulator = e;
    await check();
    expect(reminders()).toEqual([]);
  }
  store.uow.run((tx) =>
    tx.runs.put("a", { ...run(1), status: "completed" } as never),
  );
  const card = queue(2, [TYPE]);
  for (const e of [false, true]) {
    emulator = e;
    await check();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]?.instructions).toContain(`${card} 的工作在等它`);
  }
});
