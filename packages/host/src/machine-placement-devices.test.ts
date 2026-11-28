import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceObservation, Machine } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  beginMachineObservation,
  completeMachineObservation,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { DeviceRegistry } from "./device-registry.js";
import { configureMachinePlacement } from "./machine-placement.js";
import { MachineLeases } from "./resource-leases.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";

/**
 * C-850: placement reports how many devices of each type a new Run of the
 * project could take on a machine, so `android.any` can rank toward an idle
 * device. The same filter as the device lease: listed by the current check,
 * enabled for the project, not held, not reserved by another project, less
 * the owners still waiting to start that will take one.
 */
const TYPE = "android.device";
const device = (id: string): DeviceObservation => ({
  type: TYPE,
  id,
  state: "available",
  model: "MRR-W39",
  version: "12",
});
const TABLET = device("WGC6R21609003324");
const PHONE = device("10AD5Y1ZQK0033F");
const at = "2032-02-01T00:00:00.000Z";
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-idle-"));
  store = Store.open({ dataDir: dir });
  for (const p of ["first", "second"]) {
    store.createProject({ id: p });
    store.uow.run((tx) =>
      tx.machines.put(p, {
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
  }
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function configure() {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          limit: 8,
          resources: {
            "android.emulator": 1,
            [TYPE]: 2,
            // Reservable by device, as `cardigan machine reserve` needs.
            "android.device:WGC6R21609003324": 1,
          },
          adb_slots: {
            resources: ["android.emulator", TYPE],
            adb_port_base: 15100,
            emulator_port_base: 5600,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const limits = await loadRunCapacityConfig({ configDir: dir });
  expect(limits.errors).toEqual([]);
  configureMachinePlacement(
    store,
    dir,
    { CARDIGAN_CONFIG_DIR: dir },
    limits,
    () => undefined,
  );
  return limits;
}

function observe(devices: readonly DeviceObservation[], enabled: string[]) {
  const registry = new DeviceRegistry(store);
  for (const d of devices) {
    registry.discover("local", { ...d, state: "available" }, at);
    if (enabled.includes(d.id))
      store.database
        .prepare(
          "UPDATE machine_devices SET status='enabled', projects='[\"first\"]', initialized_at=? WHERE machine='local' AND type=? AND device=?",
        )
        .run(at, d.type, d.id);
  }
  const actor = { kind: "system" as const, project_id: "first" };
  beginMachineObservation(store, actor, "first", "local", "obs", at);
  completeMachineObservation(
    store,
    actor,
    "first",
    "local",
    "obs",
    {
      status: "passed",
      checked_at: at,
      blockers: [],
      launch_enabled: true,
      devices,
    },
    ["android.any", "android.emulator", TYPE].map((key) => ({
      key,
      version: null,
      verified_at: at,
      evidence_ref: `machine-observation:obs#${key}`,
    })),
  );
}

const idle = (project = "first") =>
  store.uow.run(
    (tx) =>
      loadCommandState(tx, project)
        .read_machine_placement?.(project, at)
        .machines.get("local")?.idle_devices,
  );

function hold(id: string) {
  store.database
    .prepare(
      "INSERT INTO machine_device_leases (generation,machine,type,device,project,assignment_id,run_id,acquired_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(`g-${id}`, "local", TYPE, id, "second", "A-9", "R-9", at);
}

/** An assigned owner of `first` whose Run has not started yet. */
function waiting(n: number, capabilities: string[]) {
  const item = fixture().work_items[0];
  if (!item) throw new Error("missing item");
  const owner = assignment(n);
  store.uow.run((tx) => {
    tx.cards.put("first", fixture().cards[0] as never);
    tx.work_items.put("first", {
      ...item,
      id: owner.work_item_id,
      assignment_id: owner.id,
      status: "ready",
      requirements: { capabilities },
    });
    tx.assignments.put("first", owner);
    tx.runs.put("first", { ...run(n), status: "queued" });
  });
}

test("idle devices: enabled, listed, not held, not reserved elsewhere, less waiting owners", async () => {
  const limits = await configure();
  // No check lists a device yet.
  expect(idle()).toEqual({ [TYPE]: 0 });
  // Two listed, one enabled for this project.
  observe([TABLET, PHONE], [TABLET.id, PHONE.id]);
  expect(idle()).toEqual({ [TYPE]: 2 });
  store.database
    .prepare("UPDATE machine_devices SET projects='[]' WHERE device=?")
    .run(PHONE.id);
  expect(idle()).toEqual({ [TYPE]: 1 });
  // Not enabled for the other project at all.
  expect(idle("second")).toEqual({ [TYPE]: 0 });
  // Held by a live lease (any project): not idle.
  hold(TABLET.id);
  expect(idle()).toEqual({ [TYPE]: 0 });
  store.database
    .prepare("UPDATE machine_device_leases SET released_at=? WHERE device=?")
    .run(at, TABLET.id);
  expect(idle()).toEqual({ [TYPE]: 1 });
  // Reserved by another project: not idle for this one.
  await new MachineLeases(store, limits, (() => {
    throw new Error("unused probe");
  }) as never).reserve(
    { kind: "human", project_id: "second" },
    "local",
    `${TYPE}:${TABLET.id}`,
    at,
    "2032-02-01T02:00:00.000Z",
    () => at,
  );
  expect(idle()).toEqual({ [TYPE]: 0 });
});

test("waiting android.any and device owners count against idle devices; emulator owners do not", async () => {
  await configure();
  observe([TABLET, PHONE], [TABLET.id, PHONE.id]);
  expect(idle()).toEqual({ [TYPE]: 2 });
  waiting(1, ["android.emulator"]);
  expect(idle()).toEqual({ [TYPE]: 2 });
  waiting(2, ["android.any"]);
  expect(idle()).toEqual({ [TYPE]: 1 });
  waiting(3, [TYPE]);
  expect(idle()).toEqual({ [TYPE]: 0 });
  // Never below zero.
  waiting(4, ["android.any"]);
  expect(idle()).toEqual({ [TYPE]: 0 });
});
