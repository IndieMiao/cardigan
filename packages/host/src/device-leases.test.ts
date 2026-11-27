import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceObservation, Machine, Run } from "@cardigan/domain";
import {
  beginMachineObservation,
  completeMachineObservation,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import type { AdbProbe } from "./adb-slot-probe.js";
import { DeviceRegistry } from "./device-registry.js";
import { launchDevices } from "./launch.js";
import { MachineLeases } from "./resource-leases.js";
import type { ResourceProbe } from "./resource-probe.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { assignmentResourceKeys } from "./run-resources.js";

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
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-device-"));
  store = Store.open({ dataDir: dir });
  for (const id of ["first", "second"]) store.createProject({ id });
  store.uow.run((tx) => {
    for (const id of ["first", "second"])
      tx.machines.put(id, {
        id: "local",
        label: "local",
        herdr_machine: "local",
        os: platform(),
        arch: arch(),
        tags: [],
        max_assignments: 4,
        status: "online",
        last_seen: at,
      } as unknown as Machine);
  });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const slots = {
  resources: ["android.emulator", "android.device"],
  adb_port_base: 15100,
  emulator_port_base: 5600,
};
async function config(adb: unknown = slots) {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          limit: 8,
          resources: {
            "android.emulator": 2,
            "android.device": 2,
            "android.device:WGC6R21609003324": 1,
            godot: 2,
          },
          adb_slots: adb,
        },
      },
    }),
    { mode: 0o600 },
  );
  const loaded = await loadRunCapacityConfig({ configDir: dir });
  expect(loaded.errors).toEqual([]);
  return loaded;
}
function leases(cfg: Awaited<ReturnType<typeof config>>) {
  const adb = vi.fn<AdbProbe>(async (c) => ({
    target: "target-1",
    found: c.action === "check" ? 0 : 1,
    left: 0,
  }));
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  return new MachineLeases(store, cfg, probe);
}
/** C-817: a person enabled these devices for `project` (registry only). */
function enable(devices: readonly DeviceObservation[], project = "first") {
  const registry = new DeviceRegistry(store);
  for (const d of devices) {
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
}
function observe(
  devices: readonly DeviceObservation[],
  project = "first",
  checked_at = at,
  enabled = true,
) {
  if (enabled) enable(devices, project);
  const actor = { kind: "system" as const, project_id: project };
  const id = `obs-${Math.random()}`;
  beginMachineObservation(store, actor, project, "local", id, checked_at);
  completeMachineObservation(
    store,
    actor,
    project,
    "local",
    id,
    {
      status: "passed",
      checked_at,
      blockers: [],
      launch_enabled: true,
      devices,
    },
    [],
  );
}
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
  return { owner, run: { ...run(n), status: "queued" } as Run };
}
async function claim(l: MachineLeases, n: number, caps: string[], now = at) {
  const { owner, run: r } = needs(n, caps);
  const keys = store.uow.read((tx) =>
    assignmentResourceKeys(tx, "first", owner),
  );
  const inspected = await l.inspect("first", owner, keys);
  const blocked = l.blocked("first", "local", keys, now, inspected);
  if (blocked) return { blocked, owner, run: r, keys };
  const access = store.uow.run((tx) =>
    l.acquire(tx, "first", owner, r, keys, inspected, now),
  );
  const running = { ...r, status: "running" } as Run;
  store.uow.run((tx) => tx.runs.put("first", running));
  return { access, owner, run: running, keys };
}
const launch = (l: MachineLeases, r: Run) =>
  launchDevices(l, "first", "local", r.id, at);

test("emulator only, device only and both: separate quotas, one Run per device, ANDROID_SERIAL for each", async () => {
  const l = leases(await config());
  observe([TABLET, { type: TYPE, id: "R58N", state: "unauthorized" }]);
  const emulator = await claim(l, 1, ["android.emulator"]);
  const device = await claim(l, 2, ["android.device"]);
  expect(device.access?.devices).toEqual([TABLET]);
  expect(launch(l, emulator.run)).toEqual({
    adb_slot: {
      generation: expect.any(String),
      slot: 0,
      adb_port: 15100,
      emulator_port: 5600,
      usb_off: true,
    },
  });
  expect(launch(l, device.run)).toEqual({
    adb_slot: { generation: expect.any(String), slot: 1, adb_port: 15101 },
    device_session: {
      env: { ANDROID_SERIAL: TABLET.id, CARDIGAN_DEVICE_SERIAL: TABLET.id },
      rules: [expect.stringContaining("--one-device")],
    },
  });
  // The only available tablet is taken (the unauthorized one is never
  // handed out): the next device Run waits, emulators are unaffected.
  expect((await claim(l, 3, ["android.device"])).blocked).toBe(
    "安卓真机：没有空闲的可用设备，等待释放或重新检查机器",
  );
  expect(
    (await claim(l, 4, ["android.emulator", "android.device"])).blocked,
  ).toContain("安卓真机");
  expect((await claim(l, 5, ["android.emulator"])).access?.adb).toMatchObject({
    slot: 2,
    emulator_port: 5604,
  });
  expect(l.devices.diagnostics("local")).toEqual([
    {
      type: TYPE,
      device: TABLET.id,
      project: "first",
      assignment_id: device.owner.id,
      run_id: device.run.id,
      since: at,
    },
  ]);
  expect(l.freshSession("first", device.owner)).toBe(true);
  // Ended, but its adb server is not closed yet: the device stays held.
  store.uow.run((tx) =>
    tx.runs.put("first", { ...device.run, status: "completed" } as Run),
  );
  l.devices.reconcile("first", () => later(500));
  expect(l.devices.diagnostics("local")).toHaveLength(1);
  // Slot closed: the device is released and goes to the next Run (both kinds).
  await l.adb.reconcile("first", () => later(1000));
  l.devices.reconcile("first", () => later(1000));
  expect(l.devices.diagnostics("local")).toEqual([]);
  const both = await claim(l, 6, ["android.device", "android.emulator"]);
  expect(launch(l, both.run)).toEqual({
    adb_slot: {
      generation: expect.any(String),
      slot: 1,
      adb_port: 15101,
      emulator_port: 5602,
    },
    device_session: {
      env: {
        CARDIGAN_DEVICE_SERIAL: TABLET.id,
        CARDIGAN_EMULATOR_SERIAL: "emulator-5602",
      },
      rules: [expect.stringContaining("adb -s $CARDIGAN_DEVICE_SERIAL")],
    },
  });
  const events = store
    .getUpdates({ project_id: "first" })
    .events.filter((e) => e.type.startsWith("machine_device_"));
  expect(
    events.map((e) => [e.type, (e.payload as { resource: string }).resource]),
  ).toEqual([
    ["machine_device_acquired", `${TYPE}:${TABLET.id}`],
    ["machine_device_released", `${TYPE}:${TABLET.id}`],
    ["machine_device_acquired", `${TYPE}:${TABLET.id}`],
  ]);
});

test("two Runs at once: the device appears only in the Run that holds it; the other's adb server may not claim USB", async () => {
  const l = leases(await config());
  observe([TABLET]);
  const holder = await claim(l, 1, ["android.device"]);
  const other = await claim(l, 2, ["android.emulator"]);
  const godot = await claim(l, 3, ["godot"]);
  const held = launch(l, holder.run);
  const otherLaunch = launch(l, other.run);
  expect(held.device_session?.env.ANDROID_SERIAL).toBe(TABLET.id);
  expect(held.adb_slot && held.adb_slot.usb_off).toBeUndefined();
  expect(otherLaunch.device_session).toBeUndefined();
  expect(otherLaunch.adb_slot).toMatchObject({ usb_off: true });
  expect(JSON.stringify(otherLaunch)).not.toContain(TABLET.id);
  // A Run with no slot on this machine gets no adb server at all.
  expect(launch(l, godot.run)).toEqual({ adb_slot: null });
});

test("the database never lets two live leases hold one device", async () => {
  const l = leases(await config());
  observe([TABLET]);
  await claim(l, 1, ["android.device"]);
  expect(() =>
    store.database
      .prepare(
        "INSERT INTO machine_device_leases (generation,machine,type,device,project,assignment_id,run_id,acquired_at) VALUES ('x','local',?,?,'second','A-9','R-9',?)",
      )
      .run(TYPE, TABLET.id, at),
  ).toThrow();
});

test("devices are per project account, narrowed by id or model, skip other projects' reservations, and need a current check", async () => {
  const l = leases(await config());
  // Seen as available only from the second project's account.
  observe([TABLET], "second");
  expect((await claim(l, 1, ["android.device"])).blocked).toContain("安卓真机");
  const pixel: DeviceObservation = {
    type: TYPE,
    id: "OTHER1",
    state: "available",
    model: "Pixel 8",
  };
  observe([TABLET, pixel]);
  const byModel = await claim(l, 2, ["android.device.model.pixel-8"]);
  expect(byModel.keys).toEqual(["android.device.model.pixel-8", TYPE]);
  expect(byModel.access?.devices?.map((d) => d.id)).toEqual(["OTHER1"]);
  expect((await claim(l, 3, ["android.device:OTHER1"])).blocked).toContain(
    "安卓真机",
  );
  // The other project reserved this tablet: a plain request skips it, a
  // request for exactly this device waits for the reservation.
  await l.reserve(
    { kind: "human", project_id: "second" },
    "local",
    `${TYPE}:${TABLET.id}`,
    later(-60_000),
    later(3600_000),
    () => later(-120_000),
  );
  expect((await claim(l, 4, ["android.device"])).blocked).toContain("安卓真机");
  expect(
    (await claim(l, 5, [`android.device:${TABLET.id}`])).blocked,
  ).toBeDefined();
  // After the reservation, the exact device is handed out.
  const exact = await claim(
    l,
    6,
    [`android.device:${TABLET.id}`],
    later(3600_000 + 1),
  );
  expect(exact.access?.devices?.map((d) => d.id)).toEqual([TABLET.id]);
  // A machine check older than the observation TTL proves nothing.
  expect(
    (await claim(l, 7, ["android.device"], later(25 * 3600_000))).blocked,
  ).toContain("安卓真机");
});

test("a machine whose adb slots do not include android.device never hands one out; emulator Runs there keep their old slot", async () => {
  const l = leases(await config({ ...slots, resources: ["android.emulator"] }));
  observe([TABLET]);
  expect((await claim(l, 1, ["android.device"])).blocked).toBe(
    "安卓真机：本机 adb_slots 未包含 android.device",
  );
  const emulator = await claim(l, 2, ["android.emulator"]);
  expect(launch(l, emulator.run)).toEqual({
    adb_slot: {
      generation: expect.any(String),
      slot: 0,
      adb_port: 15100,
      emulator_port: 5600,
    },
  });
});

test("C-817: only devices a person enabled for the project are handed out; disabling or losing a held device keeps its single lease", async () => {
  const l = leases(await config());
  const registry = new DeviceRegistry(store);
  // Listed but never enabled: not handed out.
  observe([TABLET], "first", at, false);
  expect((await claim(l, 1, ["android.device"])).blocked).toContain(
    "安卓真机",
  );
  // Enabled for the other project only.
  enable([TABLET], "second");
  expect((await claim(l, 2, ["android.device"])).blocked).toContain(
    "安卓真机",
  );
  enable([TABLET], "first");
  const holder = await claim(l, 3, ["android.device"]);
  expect(holder.access?.devices?.map((d) => d.id)).toEqual([TABLET.id]);
  // A person disables it while the Run holds it: the holder keeps it.
  registry.request({
    machine: "local",
    type: TYPE,
    id: TABLET.id,
    request: "disable",
    now: at,
  });
  expect(l.devices.holds("first", holder.run.id, holder.keys)).toBe(true);
  expect(launch(l, holder.run).device_session?.env.ANDROID_SERIAL).toBe(
    TABLET.id,
  );
  expect((await claim(l, 4, ["android.device"])).blocked).toBeDefined();
  // Enabled again (initialized before: no new run), then unplugged while
  // held: still never a second holder.
  expect(
    registry.request({
      machine: "local",
      type: TYPE,
      id: TABLET.id,
      request: "enable",
      projects: ["first"],
      now: at,
    }).status,
  ).toBe("enabled");
  observe([], "first", at, false);
  expect((await claim(l, 5, ["android.device"])).blocked).toBeDefined();
  observe([TABLET], "first", at, false);
  expect((await claim(l, 6, ["android.device"])).blocked).toBeDefined();
  expect(
    store.database
      .prepare(
        "SELECT count(*) AS n FROM machine_device_leases WHERE released_at IS NULL",
      )
      .get(),
  ).toEqual({ n: 1 });
});
