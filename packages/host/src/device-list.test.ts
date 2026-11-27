import { mkdtemp, rm } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceObservation, Machine } from "@cardigan/domain";
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
import { deviceList } from "./device-list.js";
import { DeviceRegistry } from "./device-registry.js";

const TYPE = "android.device";
const TABLET: DeviceObservation = {
  type: TYPE,
  id: "WGC6R21609003324",
  state: "available",
  model: "MRR-W39",
};
const PHONE: DeviceObservation = {
  type: TYPE,
  id: "R5CT1234567",
  state: "available",
  model: "SM-S9180",
};
const at = "2032-02-01T00:00:00.000Z";
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-device-list-"));
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
  const registry = new DeviceRegistry(store);
  for (const d of [TABLET, PHONE]) registry.discover("local", d, at);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function observe(
  devices: readonly DeviceObservation[],
  project = "first",
  extra: { capability_failures?: { key: string }[] } = {},
) {
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
      ...(extra.capability_failures
        ? {
            capability_failures: extra.capability_failures.map((f) => ({
              key: f.key,
              search_locations: [],
            })),
          }
        : {}),
    },
    [],
  );
}
function lease(device: string, project: string, n: number) {
  store.database
    .prepare(
      "INSERT INTO machine_device_leases (generation,machine,type,device,project,assignment_id,run_id,acquired_at) VALUES (?,'local',?,?,?,?,?,?)",
    )
    .run(`g-${n}`, TYPE, device, project, assignment(n).id, run(n).id, at);
}
const list = (project = "first") => deviceList(store, project, "local", at);

test("C-818: without a current listing nothing is claimed about the state", () => {
  expect(list()).toEqual([
    expect.objectContaining({
      machine: "local",
      id: PHONE.id,
      status: "pending",
      choices: ["first", "second"],
      projects: [],
    }),
    expect.objectContaining({ id: TABLET.id, status: "pending" }),
  ]);
  expect(list().map((d) => "state" in d || "holder" in d)).toEqual([
    false,
    false,
  ]);
});

test("C-818: the state is this project's latest listing; an unlisted device is missing", () => {
  observe([{ ...TABLET, state: "unauthorized" }]);
  observe([TABLET, { ...PHONE, state: "offline" }], "second");
  expect(list().map((d) => [d.id, d.state])).toEqual([
    [PHONE.id, "missing"],
    [TABLET.id, "unauthorized"],
  ]);
  expect(list("second").map((d) => [d.id, d.state])).toEqual([
    [PHONE.id, "offline"],
    [TABLET.id, "available"],
  ]);
  // A failed provider listing says nothing about the devices.
  observe([], "first", { capability_failures: [{ key: TYPE }] });
  expect(list().some((d) => "state" in d)).toBe(false);
});

test("C-818: the holder is the live lease; its card only for this project's Runs", () => {
  const item = fixture().work_items[0];
  if (!item) throw new Error("missing item");
  const owner = assignment(1);
  store.uow.run((tx) => {
    tx.work_items.put("first", { ...item, id: owner.work_item_id });
    tx.assignments.put("first", owner);
    tx.runs.put("first", run(1));
  });
  lease(TABLET.id, "first", 1);
  lease(PHONE.id, "second", 2);
  const [phone, tablet] = list();
  expect(tablet?.holder).toEqual({
    project: "first",
    run_id: run(1).id,
    assignment_id: owner.id,
    since: at,
    card_id: item.card_id,
  });
  expect(phone?.holder).toEqual({
    project: "second",
    run_id: run(2).id,
    assignment_id: assignment(2).id,
    since: at,
  });
  // The other project sees the same holders, without this project's card.
  expect(list("second")[1]?.holder).not.toHaveProperty("card_id");
  // A released lease no longer holds the device.
  store.database
    .prepare("UPDATE machine_device_leases SET released_at=? WHERE device=?")
    .run(at, TABLET.id);
  expect(list()[1]).not.toHaveProperty("holder");
});
