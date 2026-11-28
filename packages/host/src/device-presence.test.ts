import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceObservation,
  type Machine,
  type Run,
  remainingResourceRatio,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  beginMachineObservation,
  completeMachineObservation,
  type ReadRepositories,
  readMachineObservations,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import type { AdbProbe } from "./adb-slot-probe.js";
import {
  ANDROID_DEVICE_PROBE_COMMAND,
  androidDeviceProvider,
} from "./android-device-provider.js";
import {
  DEVICE_PRESENCE_MAX_PER_ROUND,
  refreshDevicePresence,
} from "./device-presence.js";
import { DeviceRegistry } from "./device-registry.js";
import { launchDevices } from "./launch.js";
import type { CapabilityCommand } from "./machine-capability-probe.js";
import { resolveResourceAlternatives } from "./resource-alternatives.js";
import { MachineLeases } from "./resource-leases.js";
import type { ResourceProbe } from "./resource-probe.js";
import { runCapacitySnapshot } from "./run-capacity.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { assignmentResourceKeys } from "./run-resources.js";

/**
 * C-841: an unplugged or deauthorized device stops being handed out after one
 * presence round, through the same quota, lease and alternative paths the
 * dispatcher and host launch use, and the loss reminder follows.
 */
const TYPE = "android.device";
const TABLET: DeviceObservation = {
  type: TYPE,
  id: "WGC6R21609003324",
  state: "available",
  model: "MRR-W39",
  version: "12",
};
const at = "2032-02-01T00:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const MACHINE = {
  id: "local",
  label: "local",
  herdr_machine: "local",
  os: platform(),
  arch: arch(),
  tags: [],
  max_assignments: 8,
  status: "online",
  last_seen: at,
} as unknown as Machine;
let dir: string, store: Store;
/** What a one-device adb server sees per serial; absent: nothing listed. */
let seen: Record<string, string | { fail: true }>;
let probe: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-presence-"));
  store = Store.open({ dataDir: dir });
  for (const id of ["first", "second"]) {
    store.createProject({ id });
    store.uow.run((tx) => tx.machines.put(id, MACHINE));
  }
  seen = {};
  probe = vi.fn(
    async (_e: ExecutionConfig, _os: string, command: CapabilityCommand) => {
      if (!Array.isArray(command)) return { ok: false, output: "" };
      const serial = command.at(-1) as string;
      const state = seen[serial];
      if (state && typeof state === "object") return { ok: false, output: "" };
      return {
        ok: true,
        output: JSON.stringify({
          devices: state
            ? [
                {
                  serial,
                  state,
                  ...(state === "device"
                    ? { model: "MRR-W39", android: "12" }
                    : {}),
                },
              ]
            : [],
        }),
      };
    },
  );
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function config() {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          limit: 8,
          resources: { "android.emulator": 1, "android.device": 2 },
          adb_slots: {
            resources: ["android.emulator", "android.device"],
            adb_port_base: 15100,
            emulator_port_base: 5600,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const loaded = await loadRunCapacityConfig({ configDir: dir });
  expect(loaded.errors).toEqual([]);
  return loaded;
}
type Config = Awaited<ReturnType<typeof config>>;
function leases(cfg: Config) {
  const adb = vi.fn<AdbProbe>(async (c) => ({
    target: "target-1",
    found: c.action === "check" ? 0 : 1,
    left: 0,
  }));
  const resource = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  return new MachineLeases(store, cfg, resource);
}
function enable(d: Pick<DeviceObservation, "type" | "id">, project = "first") {
  const registry = new DeviceRegistry(store);
  if (!registry.get("local", d.type, d.id))
    registry.discover("local", { ...d, state: "available" }, at);
  const current = registry.get("local", d.type, d.id);
  store.database
    .prepare(
      "UPDATE machine_devices SET status='enabled', projects=?, initialized_at=? WHERE machine='local' AND type=? AND device=?",
    )
    .run(
      JSON.stringify([...new Set([...(current?.projects ?? []), project])]),
      at,
      d.type,
      d.id,
    );
}
/** The last machine check: verified keys and listed (enabled) devices. */
function observe(
  keys: readonly string[],
  devices: readonly DeviceObservation[],
  project = "first",
) {
  for (const d of devices) enable(d, project);
  const actor = { kind: "system" as const, project_id: project };
  const id = `obs-${Math.random()}`;
  beginMachineObservation(store, actor, project, "local", id, at);
  completeMachineObservation(
    store,
    actor,
    project,
    "local",
    id,
    {
      status: "passed",
      checked_at: at,
      blockers: [],
      launch_enabled: true,
      devices,
    },
    keys.map((key) => ({
      key,
      version: null,
      verified_at: at,
      evidence_ref: `machine-observation:${id}#${key}`,
    })),
  );
  return id;
}
const EMULATOR = ["android.sdk", "android.emulator", "android.any"];
const DEVICE = [TYPE, `${TYPE}.model.mrr-w39`, `${TYPE}:${TABLET.id}`];
const BOTH = [...EMULATOR, ...DEVICE];

function needs(n: number, capabilities: string[], project = "first") {
  const item = fixture().work_items[0];
  if (!item) throw new Error("missing item");
  const owner = assignment(n);
  store.uow.run((tx) => {
    tx.work_items.put(project, {
      ...item,
      id: owner.work_item_id,
      requirements: { capabilities },
    });
    tx.assignments.put(project, owner);
    tx.runs.put(project, { ...run(n), status: "queued" });
  });
  return { owner, run: { ...run(n), status: "queued" } as Run, item };
}
/** Admission as the dispatcher does it (resolve, inspect, claim). */
async function admit(
  cfg: Config,
  l: MachineLeases,
  n: number,
  caps: string[],
  now = at,
) {
  const { owner, run: r } = needs(n, caps);
  const capacity = (tx: ReadRepositories) =>
    runCapacitySnapshot(store, tx, (m) => cfg.resourcesForMachine(m));
  const resolve = (tx: ReadRepositories) =>
    resolveResourceAlternatives(
      store,
      "first",
      owner,
      assignmentResourceKeys(tx, "first", owner),
      now,
      () => capacity(tx),
      l,
    );
  const inspected = await l.inspect(
    "first",
    owner,
    store.uow.read((tx) => resolve(tx)),
  );
  return store.uow.run((tx) => {
    const keys = resolve(tx);
    const blocked = l.blocked("first", "local", keys, now, inspected);
    const full =
      remainingResourceRatio(keys, capacity(tx).resourcesForMachine("local")) <=
      0;
    if (blocked || full)
      return { queued: blocked ?? "名额已满", keys, owner, run: r };
    const running = { ...r, status: "running", resource_keys: keys } as Run;
    tx.runs.put("first", running);
    const access = l.acquire(tx, "first", owner, running, keys, inspected, now);
    return { access, keys, owner, run: running };
  });
}
function presence(
  project = "first",
  extra: Partial<Parameters<typeof refreshDevicePresence>[0]> = {},
  now = later(60_000),
) {
  return refreshDevicePresence({
    store,
    project,
    machine: "local",
    target: () => ({
      execution: { mode: "local", dataDir: dir },
      machine: MACHINE,
    }),
    probe: probe as never,
    providers: [androidDeviceProvider],
    now: () => now,
    ...extra,
  });
}
const observed = (project = "first", now = later(60_000)) =>
  readMachineObservations(store, project, "local", now);
const keys = (project = "first", now = later(120_000)) =>
  observed(project, now)
    .capabilities.filter((c) => c.available)
    .map((c) => c.key);
const asked = () => probe.mock.calls.map(([, , c]) => c as string[]);
const reminders = (project = "first") =>
  store.uow
    .read((tx) => tx.human_actions.list(project))
    .filter((h) => h.status === "open" && h.instructions.includes("在等它"));

test("an unplugged tablet gets no new lease after one presence round, android.any takes the emulator, and the tablet is handed out again once back", async () => {
  const cfg = await config();
  const l = leases(cfg);
  observe(BOTH, [TABLET]);
  seen = {};
  expect(await presence()).toEqual({
    checked: 1,
    recorded: true,
    changed: true,
  });
  // Asked only about the one enabled tablet, through the listing script.
  expect(asked()).toEqual([[...ANDROID_DEVICE_PROBE_COMMAND, TABLET.id]]);
  expect(observed().health).toMatchObject({
    status: "passed",
    checked_at: at,
    devices: [],
    devices_checked_at: later(60_000),
    available: true,
  });
  expect(keys()).toEqual([...EMULATOR].sort());
  // Device work queues instead of starting with a serial nobody sees.
  const device = await admit(cfg, l, 1, [TYPE], later(60_000));
  expect(device.queued).toContain("没有空闲的可用设备");
  expect(device.access).toBeUndefined();
  expect(l.devices.diagnostics("local")).toEqual([]);
  // android.any is not stuck on the tablet: it takes the emulator.
  const any = await admit(cfg, l, 2, ["android.any"], later(60_000));
  expect(any.keys).toEqual(["android.any", "android.emulator"]);
  expect(JSON.stringify(any.access)).not.toContain(TABLET.id);
  // Plugged back in: the next round lists it and it is handed out again.
  seen = { [TABLET.id]: "device" };
  expect(await presence(undefined, {}, later(120_000))).toMatchObject({
    recorded: true,
    changed: true,
  });
  expect(observed().health?.devices).toEqual([TABLET]);
  expect(keys()).toEqual([...BOTH].sort());
  const back = await admit(cfg, l, 3, [TYPE], later(120_000));
  expect(back.access?.devices).toEqual([TABLET]);
  expect(
    launchDevices(l, "first", "local", back.run.id, later(120_000))
      .device_session?.env,
  ).toEqual({ ANDROID_SERIAL: TABLET.id, CARDIGAN_DEVICE_SERIAL: TABLET.id });
});

test("a lost authorization on a device-only machine drops the device and android.any until it is allowed again", async () => {
  observe(["android.sdk", "android.any", ...DEVICE], [TABLET]);
  seen = { [TABLET.id]: "unauthorized" };
  await presence();
  expect(observed().health?.devices).toEqual([
    { type: TYPE, id: TABLET.id, state: "unauthorized" },
  ]);
  expect(keys()).toEqual(["android.sdk"]);
  seen = { [TABLET.id]: "device" };
  await presence();
  expect(keys()).toEqual(["android.any", "android.sdk", ...DEVICE].sort());
  // Unchanged answers keep the observation as it is.
  expect(await presence()).toMatchObject({ recorded: true, changed: false });
});

test("the loss reminder appears within a round while work waits on the device, and closes when it is back", async () => {
  observe(["android.sdk", ...DEVICE], [TABLET]);
  const { item } = needs(1, [TYPE]);
  seen = { [TABLET.id]: "device" };
  await presence();
  expect(reminders()).toEqual([]);
  seen = {};
  await presence();
  expect(reminders()).toHaveLength(1);
  expect(reminders()[0]?.instructions).toContain(
    `local 上的安卓真机 MRR-W39（${TABLET.id}）已拔掉或看不到，${item.card_id} 的工作在等它`,
  );
  seen = { [TABLET.id]: "device" };
  await presence();
  expect(reminders()).toEqual([]);
});

test("work that starts waiting on an already missing device is reminded at the next round", async () => {
  observe(["android.sdk", ...DEVICE], [TABLET]);
  seen = {};
  await presence();
  expect(reminders()).toEqual([]);
  needs(1, [TYPE]);
  // Nothing changed about the device, the reminder still follows the queue.
  expect(await presence()).toMatchObject({ recorded: true, changed: false });
  expect(reminders()).toHaveLength(1);
});

test("a device a Run holds (any project), a device not enabled for the project and devices beyond the round's limit are not asked", async () => {
  const cfg = await config();
  const l = leases(cfg);
  observe(BOTH, [TABLET]);
  // A Run holds the tablet: the presence check never touches it.
  const held = await admit(cfg, l, 1, [TYPE]);
  expect(held.access?.devices).toEqual([TABLET]);
  expect(await presence()).toEqual({
    checked: 0,
    recorded: false,
    changed: false,
  });
  expect(probe).not.toHaveBeenCalled();
  // The other project sees the same lease (machine-wide).
  observe(BOTH, [TABLET], "second");
  expect((await presence("second")).checked).toBe(0);
  expect(probe).not.toHaveBeenCalled();

  // Not enabled for this project: never asked.
  const other = { type: TYPE, id: "R58N" };
  new DeviceRegistry(store).discover(
    "local",
    { ...other, state: "available" },
    at,
  );
  expect((await presence()).checked).toBe(0);
  // Enabled ones are asked in id order, at most the round's limit.
  const many = Array.from(
    { length: DEVICE_PRESENCE_MAX_PER_ROUND + 1 },
    (_, i) => ({
      type: TYPE,
      id: `S${i}`,
    }),
  );
  for (const d of many) enable(d);
  expect((await presence()).checked).toBe(DEVICE_PRESENCE_MAX_PER_ROUND);
  expect(asked().map((c) => c.at(-1))).toEqual(
    many.slice(0, DEVICE_PRESENCE_MAX_PER_ROUND).map((d) => d.id),
  );
});

test("a failed check keeps what is known; a machine check started meanwhile, a failed or missing observation and another binding write nothing", async () => {
  observe(["android.sdk", ...DEVICE], [TABLET]);
  // No answer (for example an adb without --one-device): nothing changes.
  seen = { [TABLET.id]: { fail: true } };
  expect(await presence()).toEqual({
    checked: 1,
    recorded: false,
    changed: false,
  });
  expect(observed().health?.devices).toEqual([TABLET]);
  expect(keys()).toEqual(["android.sdk", ...DEVICE].sort());

  // A machine check begins while the device is being asked: it wins.
  seen = {};
  probe.mockImplementationOnce(async () => {
    beginMachineObservation(
      store,
      { kind: "system", project_id: "first" },
      "first",
      "local",
      "newer",
      later(30_000),
    );
    return { ok: true, output: JSON.stringify({ devices: [] }) };
  });
  expect(await presence()).toMatchObject({ checked: 1, recorded: false });
  expect(observed().health).toMatchObject({ status: "checking" });

  // A failed observation: nothing is asked.
  const actor = { kind: "system" as const, project_id: "first" };
  completeMachineObservation(
    store,
    actor,
    "first",
    "local",
    "newer",
    {
      status: "failed",
      checked_at: later(30_000),
      blockers: ["worker_unreachable"],
      launch_enabled: false,
    },
    [],
  );
  probe.mockClear();
  expect((await presence()).checked).toBe(0);
  // No observation of this project at all.
  expect((await presence("second")).checked).toBe(0);
  // A binding other than the one the observation was made with.
  observe(["android.sdk", ...DEVICE], [TABLET]);
  expect(
    (
      await presence("first", {
        target: () => ({
          execution: {
            mode: "agent-ssh",
            target: { fingerprint: "other" },
          } as unknown as ExecutionConfig,
          machine: MACHINE,
        }),
      })
    ).checked,
  ).toBe(0);
  // Without a prerequisite capability (android.sdk), nothing is asked.
  observe(DEVICE, [TABLET]);
  expect((await presence()).checked).toBe(0);
  expect(probe).not.toHaveBeenCalled();
});
