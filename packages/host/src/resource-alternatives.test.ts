import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceObservation,
  type Machine,
  type Run,
  remainingResourceRatio,
} from "@cardigan/domain";
import {
  beginMachineObservation,
  completeMachineObservation,
  type ReadRepositories,
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
import { resolveResourceAlternatives } from "./resource-alternatives.js";
import { MachineLeases } from "./resource-leases.js";
import type { ResourceProbe } from "./resource-probe.js";
import { runCapacitySnapshot } from "./run-capacity.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { assignmentResourceKeys } from "./run-resources.js";

/**
 * C-815: 安卓设备任一 on one machine with emulator slots and a USB tablet,
 * through the same quota, adb slot and device lease paths the dispatcher
 * and host launch use.
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
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-any-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: "first" });
  store.uow.run((tx) =>
    tx.machines.put("first", {
      id: "local",
      label: "local",
      herdr_machine: "local",
      os: platform(),
      arch: arch(),
      tags: [],
      max_assignments: 8,
      status: "online",
      last_seen: at,
    } as unknown as Machine),
  );
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function config(emulators = 1) {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          limit: 8,
          resources: { "android.emulator": emulators, "android.device": 1 },
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
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  return new MachineLeases(store, cfg, probe);
}
/** One machine check: verified capability keys and listed devices. */
function observe(
  keys: readonly string[],
  devices: readonly DeviceObservation[],
) {
  // C-817: the listed devices were enabled for this project by a person.
  const registry = new DeviceRegistry(store);
  for (const d of devices) {
    registry.discover("local", { ...d, state: "available" }, at);
    store.database
      .prepare(
        "UPDATE machine_devices SET status='enabled', projects='[\"first\"]', initialized_at=? WHERE machine='local' AND type=? AND device=?",
      )
      .run(at, d.type, d.id);
  }
  const actor = { kind: "system" as const, project_id: "first" };
  const id = `obs-${Math.random()}`;
  beginMachineObservation(store, actor, "first", "local", id, at);
  completeMachineObservation(
    store,
    actor,
    "first",
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
}
const EMULATOR_ONLY = ["android.sdk", "android.emulator", "android.any"];
const BOTH = [...EMULATOR_ONLY, TYPE, `${TYPE}:${TABLET.id}`];
const DEVICE_ONLY = [
  "android.sdk",
  "android.any",
  TYPE,
  `${TYPE}:${TABLET.id}`,
];

function needs(n: number, capabilities: string[]) {
  const item = fixture().work_items[0];
  if (!item) throw new Error("missing item");
  const owner = assignment(n);
  store.uow.run((tx) => {
    tx.work_items.put("first", {
      ...item,
      id: owner.work_item_id,
      requirements: { capabilities },
    });
    tx.assignments.put("first", owner);
    tx.runs.put("first", { ...run(n), status: "queued" });
  });
  return { owner, run: { ...run(n), status: "queued" } as Run };
}

/**
 * Admission as the dispatcher does it: resolve, inspect, then inside one
 * transaction resolve again, check quota and leases, and acquire. The Run
 * keeps the resolved keys, which is what the capacity count reads.
 */
async function admit(cfg: Config, l: MachineLeases, n: number, caps: string[]) {
  const { owner, run: r } = needs(n, caps);
  const capacity = (tx: ReadRepositories) =>
    runCapacitySnapshot(store, tx, (m) => cfg.resourcesForMachine(m));
  const resolve = (tx: ReadRepositories) =>
    resolveResourceAlternatives(
      store,
      "first",
      owner,
      assignmentResourceKeys(tx, "first", owner),
      at,
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
    const blocked = l.blocked("first", "local", keys, at, inspected);
    const full =
      remainingResourceRatio(keys, capacity(tx).resourcesForMachine("local")) <=
      0;
    if (blocked || full)
      return { queued: blocked ?? "名额已满", keys, owner, run: r };
    const running = { ...r, status: "running", resource_keys: keys } as Run;
    tx.runs.put("first", running);
    const access = l.acquire(tx, "first", owner, running, keys, inspected, at);
    return { access, keys, owner, run: running };
  });
}
const env = (l: MachineLeases, r: Run) =>
  launchDevices(l, "first", "local", r.id, at);
async function end(l: MachineLeases, r: Run, ms: number) {
  store.uow.run((tx) =>
    tx.runs.put("first", { ...r, status: "completed" } as Run),
  );
  await l.adb.reconcile("first", () => later(ms));
  l.devices.reconcile("first", () => later(ms));
}

test("android.any takes the free emulator, then the free tablet, queues while both are busy, and takes whichever is released first", async () => {
  const cfg = await config(1);
  const l = leases(cfg);
  observe(BOTH, [TABLET]);
  const first = await admit(cfg, l, 1, ["android.any"]);
  expect(first.keys).toEqual(["android.any", "android.emulator"]);
  expect(env(l, first.run)).toEqual({
    adb_slot: {
      generation: expect.any(String),
      slot: 0,
      adb_port: 15100,
      emulator_port: 5600,
      usb_off: true,
    },
  });
  // The only emulator slot is taken: the next one gets the tablet, exclusively.
  const second = await admit(cfg, l, 2, ["android.any"]);
  expect(second.keys).toEqual(["android.any", TYPE]);
  expect(second.access?.devices).toEqual([TABLET]);
  expect(env(l, second.run).device_session?.env).toEqual({
    ANDROID_SERIAL: TABLET.id,
    CARDIGAN_DEVICE_SERIAL: TABLET.id,
  });
  expect(JSON.stringify(env(l, first.run))).not.toContain(TABLET.id);
  // Both busy: it queues (for the emulator, the first the machine has).
  const third = await admit(cfg, l, 3, ["android.any"]);
  expect(third.queued).toBeDefined();
  expect(third.keys).toEqual(["android.any", "android.emulator"]);
  // The tablet comes back first: the waiting Run now takes it.
  await end(l, second.run, 1000);
  expect(l.devices.diagnostics("local")).toEqual([]);
  const retried = await admit(cfg, l, 3, ["android.any"]);
  expect(retried.keys).toEqual(["android.any", TYPE]);
  expect(retried.access?.devices?.map((d) => d.id)).toEqual([TABLET.id]);
  // Then the emulator: the next waiting Run gets it.
  expect((await admit(cfg, l, 4, ["android.any"])).queued).toBeDefined();
  await end(l, first.run, 2000);
  const fourth = await admit(cfg, l, 4, ["android.any"]);
  expect(fourth.keys).toEqual(["android.any", "android.emulator"]);
  expect(fourth.access?.adb).toMatchObject({ emulator_port: 5600 });
  expect(
    store
      .getUpdates({ project_id: "first" })
      .events.filter((e) => e.type.startsWith("machine_device_"))
      .map((e) => [e.type, (e.payload as { run_id: string }).run_id]),
  ).toEqual([
    ["machine_device_acquired", second.run.id],
    ["machine_device_released", second.run.id],
    ["machine_device_acquired", retried.run.id],
  ]);
});

test("android.any on a machine with only an emulator, or only a tablet, uses what is there", async () => {
  const cfg = await config(2);
  const l = leases(cfg);
  observe(EMULATOR_ONLY, []);
  const a = await admit(cfg, l, 1, ["android.any"]);
  const b = await admit(cfg, l, 2, ["android.any"]);
  expect([a.keys, b.keys]).toEqual([
    ["android.any", "android.emulator"],
    ["android.any", "android.emulator"],
  ]);
  // No device on this machine: the third waits for an emulator slot.
  const c = await admit(cfg, l, 3, ["android.any"]);
  expect(c.queued).toBeDefined();
  expect(c.keys).toEqual(["android.any", "android.emulator"]);
  await end(l, a.run, 1000);
  await end(l, b.run, 1000);

  observe(DEVICE_ONLY, [TABLET]);
  const d = await admit(cfg, l, 4, ["android.any"]);
  expect(d.keys).toEqual(["android.any", TYPE]);
  expect(env(l, d.run).device_session?.env.ANDROID_SERIAL).toBe(TABLET.id);
  // The emulator binary is gone, so even with free slots no emulator.
  const e = await admit(cfg, l, 5, ["android.any"]);
  expect(e.keys).toEqual(["android.any", TYPE]);
  expect(e.queued).toContain("安卓真机");
});

test("work items asking for a concrete kind are not re-resolved: android.emulator still waits for an emulator while the tablet is free", async () => {
  const cfg = await config(1);
  const l = leases(cfg);
  observe(BOTH, [TABLET]);
  const emulator = await admit(cfg, l, 1, ["android.emulator"]);
  expect(emulator.keys).toEqual(["android.emulator"]);
  const waiting = await admit(cfg, l, 2, ["android.emulator"]);
  expect(waiting.keys).toEqual(["android.emulator"]);
  expect(waiting.queued).toBeDefined();
  expect(l.devices.diagnostics("local")).toEqual([]);
  // android.any narrowed to a device stays a device request.
  const narrowed = await admit(cfg, l, 3, [
    "android.any",
    `${TYPE}:${TABLET.id}`,
  ]);
  expect(narrowed.keys).toEqual(["android.any", `${TYPE}:${TABLET.id}`, TYPE]);
  expect(narrowed.access?.devices?.map((d) => d.id)).toEqual([TABLET.id]);
  // Nothing to resolve: the keys come back as they are.
  expect(
    store.uow.read((tx) =>
      resolveResourceAlternatives(
        store,
        "first",
        emulator.owner,
        ["android.emulator", "godot"],
        at,
        () => {
          throw new Error("no capacity read without an alternative");
        },
        l,
      ),
    ),
  ).toEqual(["android.emulator", "godot"]);
});

test("an android.any Assignment may need an adb slot and a fresh session per Run", async () => {
  const cfg = await config(1);
  const l = leases(cfg);
  observe(BOTH, [TABLET]);
  const { owner } = needs(1, ["android.any"]);
  expect(l.adbNeeded("first", owner)).toBe(true);
  expect(l.freshSession("first", owner)).toBe(true);
});
