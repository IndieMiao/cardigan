import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  card,
  machine,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import {
  CAPACITY_WAIT_REASON,
  cancelMachineReservation,
  listMachineReservations,
  reservationIdOf,
  resourceWaits,
} from "./machine-reservations.js";
import { MachineLeases } from "./resource-leases.js";
import { machineRunCapacity } from "./run-capacity.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";

const start = "2032-02-01T00:00:00.000Z",
  mid = "2032-02-01T01:00:00.000Z",
  end = "2032-02-01T02:00:00.000Z",
  before = "2032-01-31T00:00:00.000Z";
const holder = { kind: "human" as const, project_id: "first" };
const SECRET = "holder-card-secret-title";
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-reservations-"));
  store = Store.open({ dataDir: dir });
  for (const id of ["first", "second"]) store.createProject({ id });
  store.uow.run((tx) => {
    tx.cards.put("first", { ...card(1), title: SECRET, goal: SECRET });
    for (const id of ["first", "second"]) tx.machines.put(id, machine());
  });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});
async function leases() {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({ machines: { local: { resources: { fixture: 1 } } } }),
    { mode: 0o600 },
  );
  const cfg = await loadRunCapacityConfig({ configDir: dir });
  expect(cfg.errors).toEqual([]);
  return new MachineLeases(store, cfg, vi.fn());
}
const waitRows = () =>
  store.database
    .prepare(
      "SELECT project,run_id,kind,reservation FROM machine_resource_waits ORDER BY run_id",
    )
    .all()
    .map((row) => ({ ...row }));
const events = (project: string, type: string) =>
  store
    .getUpdates({ project_id: project })
    .events.filter((e) => e.type === type);

test("C-800 another project's reservation names holder, source, window and id; the wait records its kind without card content", async () => {
  const l = await leases();
  const id = await l.reserve(
    holder,
    "local",
    "fixture",
    start,
    end,
    () => start,
  );
  const reason = l.blocked("second", "local", ["fixture"], start);
  expect(reason).toBe(
    `fixture：预约独占（持有项目 first，人工预约，${start} — ${end}，预约 ${id}）`,
  );
  expect(reservationIdOf(reason ?? "")).toBe(id);
  expect(l.blocked("first", "local", ["fixture"], start)).toBeUndefined();
  store.uow.run((tx) => {
    l.wait(tx, "second", assignment(1), run(1), reason ?? "", start);
    l.wait(
      tx,
      "second",
      assignment(2),
      run(2),
      CAPACITY_WAIT_REASON,
      start,
      false,
    );
    l.wait(tx, "second", assignment(3), run(3), "fixture：等待释放核验", start);
  });
  expect(waitRows()).toEqual([
    {
      project: "second",
      run_id: run(1).id,
      kind: "reservation",
      reservation: id,
    },
    {
      project: "second",
      run_id: run(2).id,
      kind: "capacity",
      reservation: null,
    },
    {
      project: "second",
      run_id: run(3).id,
      kind: "resource",
      reservation: null,
    },
  ]);
  const reservation = {
    reservation_id: id,
    machine: "local",
    resource: "fixture",
    holder_project: "first",
    source: "human",
    starts_at: start,
    ends_at: end,
  };
  const waits = resourceWaits(store.database, "second");
  expect(waits.get(run(1).id)).toEqual({
    kind: "reservation",
    reason,
    reservation,
  });
  expect(waits.get(run(2).id)).toEqual({
    kind: "capacity",
    reason: CAPACITY_WAIT_REASON,
  });
  const waiting = events("second", "machine_resource_waiting");
  expect(waiting.map((e) => e.payload)).toEqual([
    expect.objectContaining({
      run_id: run(1).id,
      kind: "reservation",
      reservation: expect.objectContaining({
        reservation_id: id,
        holder_project: "first",
        source: "human",
      }),
    }),
    expect.objectContaining({ run_id: run(2).id, kind: "capacity" }),
    expect.objectContaining({ run_id: run(3).id, kind: "resource" }),
  ]);
  // The PM scheduling view lists the same metadata on the machine row.
  const capacity = store.uow.read((tx) =>
    machineRunCapacity(store, tx, { reservationsAt: start }),
  );
  const { machine: _m, ...summary } = reservation;
  expect(capacity.find((m) => m.machine_id === "local")?.reservations).toEqual([
    summary,
  ]);
  expect(
    store.uow
      .read((tx) => machineRunCapacity(store, tx))
      .find((m) => m.machine_id === "local"),
  ).not.toHaveProperty("reservations");
  // Nothing the blocked project reads carries the holder's card content.
  expect(
    JSON.stringify([reason, [...waits.values()], waiting, capacity]),
  ).not.toContain(SECRET);
});

test("C-800 only a human with a reason can cancel; the window closes, waits are cleared and both projects get an event", async () => {
  const l = await leases();
  const id = await l.reserve(
    holder,
    "local",
    "fixture",
    start,
    end,
    () => start,
  );
  const reason = l.blocked("second", "local", ["fixture"], start) ?? "";
  store.uow.run((tx) => {
    l.wait(tx, "second", assignment(1), run(1), reason, start);
    l.wait(
      tx,
      "second",
      assignment(2),
      run(2),
      CAPACITY_WAIT_REASON,
      start,
      false,
    );
  });
  const cancel = (
    actor = { kind: "human" as const, project_id: "second" },
    why = "所有者要求提前恢复",
  ) =>
    cancelMachineReservation(
      store,
      actor,
      { reservation_id: id, reason: why },
      () => mid,
    );
  expect(() =>
    cancel({ kind: "system", project_id: "second" } as never),
  ).toThrow("仅限人");
  expect(() =>
    cancelMachineReservation(
      store,
      {
        kind: "assignment",
        project_id: "first",
        assignment_id: assignment().id,
        role_id: "pm",
        role_version: 1,
        allowed_tools: [],
        capabilities: [],
      } as never,
      { reservation_id: id, reason: "x" },
      () => mid,
    ),
  ).toThrow("仅限人");
  expect(() => cancel(undefined, "  ")).toThrow("取消原因");
  expect(() =>
    cancelMachineReservation(
      store,
      { kind: "human", project_id: "second" },
      { reservation_id: id, reason: "x", machine: "elsewhere" },
      () => mid,
    ),
  ).toThrow("预约不存在");
  expect(l.blocked("second", "local", ["fixture"], mid)).toBe(reason);

  expect(cancel()).toMatchObject({
    reservation: { reservation_id: id, holder_project: "first" },
    released_runs: 1,
  });
  expect(l.blocked("second", "local", ["fixture"], mid)).toBeUndefined();
  expect(listMachineReservations(store.database, { now: mid })).toEqual([]);
  // Only the Run held by this reservation is released.
  expect(waitRows()).toEqual([
    {
      project: "second",
      run_id: run(2).id,
      kind: "capacity",
      reservation: null,
    },
  ]);
  const [own] = events("first", "machine_resource_reservation_cancelled");
  expect(own?.actor).toEqual({ kind: "human", project_id: "first" });
  expect(own?.payload).toMatchObject({
    reservation_id: id,
    reason: "所有者要求提前恢复",
    ends_at: end,
    cancelled_at: mid,
    physical_release: "not_applicable",
  });
  const [peer] = events("second", "machine_resource_reservation_cancelled");
  expect(peer?.payload).toMatchObject({
    reservation_id: id,
    holder_project: "first",
    run_ids: [run(1).id],
  });
  expect(peer?.payload).not.toHaveProperty("reason");
  expect(JSON.stringify(peer)).not.toContain(SECRET);

  expect(() => cancel()).toThrow("预约已结束");
  // The cancel already closed the window: no second deadline audit later.
  await l.reconcile("first", () => end);
  expect(events("first", "machine_resource_deadline")).toEqual([]);
});

test("C-800 a cancelled future reservation frees its window and list filters by machine", async () => {
  const l = await leases();
  const id = await l.reserve(
    holder,
    "local",
    "fixture",
    start,
    end,
    () => before,
  );
  expect(
    listMachineReservations(store.database, { now: before, machine: "local" }),
  ).toEqual([
    expect.objectContaining({ reservation_id: id, holder_project: "first" }),
  ]);
  expect(
    listMachineReservations(store.database, { now: before, machine: "other" }),
  ).toEqual([]);
  await expect(
    l.reserve(
      { kind: "human", project_id: "second" },
      "local",
      "fixture",
      start,
      end,
      () => before,
    ),
  ).rejects.toThrow();
  cancelMachineReservation(
    store,
    { kind: "human", project_id: "second" },
    { reservation_id: id, reason: "改期", machine: "local" },
    () => before,
  );
  const next = await l.reserve(
    { kind: "human", project_id: "second" },
    "local",
    "fixture",
    start,
    end,
    () => before,
  );
  expect(listMachineReservations(store.database, { now: before })).toEqual([
    expect.objectContaining({ reservation_id: next, holder_project: "second" }),
  ]);
  expect(l.blocked("first", "local", ["fixture"], start)).toContain(
    "持有项目 second",
  );
});
