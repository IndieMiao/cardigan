import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  Delivery,
  Event,
  EventId,
  JsonValue,
  Machine,
  Run,
  WorkItem,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  id,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { MachineLeases } from "./resource-leases.js";
import type { ResourceProbe } from "./resource-probe.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { runResourceKeys, unclaimedResourceKeys } from "./run-resources.js";

const project = "first";
const at = "2032-02-01T00:00:00.000Z";
const FULL = ["godot", "android.emulator"];
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-run-resources-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project });
  store.uow.run((tx) =>
    tx.machines.put(project, {
      id: "local",
      label: "local",
      herdr_machine: "local",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 4,
      status: "online",
      last_seen: at,
    } as unknown as Machine),
  );
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const [produce, verify] = fixture().work_items as [WorkItem, WorkItem];
/** A-1 produces W-1; A-5 produces W-5 (depends on W-1); A-2 reviews W-1. */
function seed() {
  const owner = assignment(1),
    downstream = assignment(5),
    reviewer = assignment(2, "reviewer");
  store.uow.run((tx) => {
    tx.work_items.put(project, {
      ...produce,
      requirements: { capabilities: FULL },
    });
    tx.work_items.put(project, {
      ...produce,
      id: id("work_item", 5),
      assignment_id: downstream.id,
      depends_on: [produce.id],
      requirements: { capabilities: ["godot"] },
    });
    tx.work_items.put(project, {
      ...verify,
      requirements: { capabilities: FULL },
    });
    for (const a of [owner, downstream, reviewer])
      tx.assignments.put(project, a);
    tx.deliveries.put(project, {
      id: id("delivery", 1),
      work_item_id: produce.id,
    } as unknown as Delivery);
  });
  return { owner, downstream, reviewer };
}

let seq = 0;
const system: Actor = { kind: "system", project_id: project };
const human: Actor = { kind: "human", project_id: project };
function event(type: string, payload: JsonValue = {}, actor = human): Event {
  seq++;
  return {
    id: String(seq).padStart(26, "0") as EventId,
    seq,
    card_id: produce.card_id,
    type,
    actor,
    payload,
    created_at: at,
  };
}
const pass = (extra: Record<string, JsonValue> = {}) =>
  event("review_submitted", {
    delivery_id: id("delivery", 1),
    verdict: "pass",
    recheck_required: false,
    rework_allowed: false,
    issues: [],
    ...extra,
  });

function keys(
  owner: Assignment,
  trigger: Event | undefined,
  kind: Run["kind"] = "followup",
  notes: { kind: string; event: Event }[] = trigger
    ? [{ kind: "comment", event: trigger }]
    : [],
) {
  const events = [...(trigger ? [trigger] : []), ...notes.map((n) => n.event)];
  return store.uow.read((tx) =>
    runResourceKeys(
      tx,
      project,
      owner,
      events,
      { kind, ...(trigger ? { trigger_event_id: trigger.id } : {}) },
      notes.map((n) => ({ kind: n.kind, event_id: n.event.id })),
    ),
  );
}

test("C-721 a producer follow-up that only submits or replies claims no resources", () => {
  const { owner } = seed();
  expect(keys(owner, event("comment_posted"))).toEqual([]);
  const passed = pass({
    issues: [{ severity: "minor", must_fix: false, body: "later" }],
  });
  expect(
    keys(owner, passed, "followup", [{ kind: "completion", event: passed }]),
  ).toEqual([]);
  const accepted = event("delivery_accepted", {
    delivery_id: id("delivery", 1),
  });
  expect(
    keys(owner, accepted, "followup", [
      { kind: "completion", event: accepted },
    ]),
  ).toEqual([]);
  const completion = event("completion_reviewed", {
    delivery_id: id("delivery", 1),
    verdict: "pass",
    rework_allowed: false,
  });
  expect(
    keys(owner, completion, "followup", [
      { kind: "completion", event: completion },
    ]),
  ).toEqual([]);
  const precheck = event(
    "precheck_finished",
    { status: "passed", assignment_id: owner.id, work_item_id: produce.id },
    system,
  );
  expect(
    keys(owner, precheck, "followup", [
      { kind: "instruction", event: precheck },
    ]),
  ).toEqual([]);
  // A Run with no pending notice (a capacity retry) is judged by its trigger.
  expect(keys(owner, event("comment_posted"), "followup", [])).toEqual([]);
});

test.each(["rework", "fix", "decision_resumed", "initial"] as const)(
  "C-721 a %s Run keeps the work item's resources even when a comment woke it",
  (kind) => {
    const { owner } = seed();
    expect(keys(owner, event("comment_posted"), kind)).toEqual(FULL);
  },
);

test("C-721 anything beyond a plain pass, a reply or a passed precheck keeps every resource", () => {
  const { owner, downstream, reviewer } = seed();
  const heavy: [string, Event, Assignment?][] = [
    ["instruction", event("instruction_issued", { work_item_id: produce.id })],
    [
      "blocker resume",
      event("work_item_resume_requested", { work_item_id: produce.id }),
    ],
    ["decision", event("decision_resolved", { decision_id: "Q-1" })],
    ["rejection", pass({ verdict: "reject", rework_allowed: true })],
    ["conditional", pass({ verdict: "conditional" })],
    [
      "must fix",
      pass({ issues: [{ severity: "major", must_fix: true, body: "fix" }] }),
    ],
    ["pending evidence", pass({ evidence_pending: { items: [] } })],
    ["late parallel", pass({ parallel_late: true })],
    [
      "failed precheck",
      event(
        "precheck_finished",
        { status: "failed", assignment_id: owner.id, work_item_id: produce.id },
        system,
      ),
    ],
    [
      "forged precheck",
      event("precheck_finished", {
        status: "passed",
        assignment_id: owner.id,
        work_item_id: produce.id,
      }),
    ],
    ["other card", { ...event("comment_posted"), card_id: id("card", 2) }],
    // The upstream pass starts the dependent item's own work.
    ["dependency wake", pass(), downstream],
    // Reviewers verify on the device; their comment Runs are real work.
    ["reviewer comment", event("comment_posted"), reviewer],
  ];
  for (const [name, trigger, who = owner] of heavy)
    expect({ name, keys: keys(who, trigger) }, name).toEqual({
      name,
      keys: who === downstream ? ["godot"] : FULL,
    });
  // A trigger missing from the loaded history is never assumed light.
  expect(
    store.uow.read((tx) =>
      runResourceKeys(
        tx,
        project,
        owner,
        [],
        { kind: "followup", trigger_event_id: "0".repeat(26) },
        [],
      ),
    ),
  ).toEqual(FULL);
});

test("C-721 one heavy notice in the same bell keeps every resource", () => {
  const { owner } = seed();
  const reply = event("comment_posted");
  const more = event("comment_posted");
  expect(
    keys(owner, reply, "followup", [
      { kind: "comment", event: reply },
      { kind: "comment", event: more },
    ]),
  ).toEqual([]);
  const order = event("instruction_issued", { work_item_id: produce.id });
  expect(
    keys(owner, reply, "followup", [
      { kind: "comment", event: reply },
      { kind: "instruction", event: order },
    ]),
  ).toEqual(FULL);
  // A rejection routed as a review notice, even on a passing event shape.
  const review = pass();
  expect(
    keys(owner, reply, "followup", [
      { kind: "comment", event: reply },
      { kind: "review", event: review },
    ]),
  ).toEqual(FULL);
});

test("C-721 a light Run gets no adb slot or emulator next to a slot holder, and its empty claim inspects cleanly", async () => {
  const { owner } = seed();
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          limit: 6,
          resources: { "android.emulator": 1, godot: 1 },
          adb_slots: {
            resources: FULL,
            adb_port_base: 15100,
            emulator_port_base: 5600,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const cfg = await loadRunCapacityConfig({ configDir: dir });
  expect(cfg.errors).toEqual([]);
  const adb = vi.fn(async () => ({ target: "target-1", found: 0, left: 0 }));
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  const leases = new MachineLeases(store, cfg, probe);
  // The recording Run holds the emulator.
  const holder = {
    ...run(9, 1),
    trigger_event_id: "00000000000000000000000009",
    status: "queued",
  } as Run;
  const light = {
    ...run(10, 1),
    trigger_event_id: "00000000000000000000000010",
    status: "queued",
  } as Run;
  store.uow.run((tx) => {
    tx.runs.put(project, holder);
    tx.runs.put(project, light);
  });
  const full = await leases.inspect(project, owner);
  const held = store.uow.run((tx) =>
    leases.acquire(tx, project, owner, holder, FULL, full, at),
  );
  expect(held?.adb).toMatchObject({ emulator_port: 5600 });
  store.uow.run((tx) =>
    tx.runs.put(project, {
      ...holder,
      status: "running",
      resource_keys: FULL,
    }),
  );

  // The light Run's empty claim matches its own inspection.
  const inspected = await leases.inspect(project, owner, []);
  expect(leases.blocked(project, "local", [], at, inspected)).toBeUndefined();
  // Inspecting the work item's keys instead would report a changed claim.
  expect(leases.blocked(project, "local", [], at, full)).toBe("资源需求已变化");
  const access = store.uow.run((tx) =>
    leases.acquire(tx, project, owner, light, [], inspected, at),
  );
  expect(access?.adb).toBeUndefined();
  const admitted = { ...light, resource_keys: [] } as Run;
  store.uow.run((tx) => tx.runs.put(project, admitted));
  // Its launch compiles with no slot (ADB_SERVER_SOCKET to /dev/null) ...
  expect(leases.adb.launchSlot(project, "local", light.id)).toBeNull();
  expect(leases.adb.launchSlot(project, "local", holder.id)).toMatchObject({
    emulator_port: 5600,
  });
  expect(leases.startBlocked(project, owner, admitted, at)).toBeUndefined();
  // ... in a fresh session, never one that kept an earlier Run's adb ports.
  expect(leases.freshSession(project, owner)).toBe(true);
  // A Run that does need the emulator is refused until it is admitted with a slot.
  const heavy = {
    ...run(11, 1),
    trigger_event_id: "00000000000000000000000011",
    status: "queued",
  } as Run;
  store.uow.run((tx) => tx.runs.put(project, heavy));
  expect(
    leases.startBlocked(project, owner, { ...heavy, resource_keys: FULL }, at),
  ).toEqual(expect.any(String));
});

test("C-721 an admitted Run reports the work item's resources it does not hold", () => {
  const { owner } = seed();
  const unclaimed = (run: Pick<Run, "resource_keys"> | undefined) =>
    store.uow.read((tx) => unclaimedResourceKeys(tx, project, owner, run));
  expect(unclaimed({ resource_keys: [] })).toEqual(FULL);
  expect(unclaimed({ resource_keys: ["godot"] })).toEqual(["android.emulator"]);
  expect(unclaimed({ resource_keys: FULL })).toEqual([]);
  // No admission snapshot (legacy) or no Run: nothing is known to be missing.
  expect(unclaimed({})).toEqual([]);
  expect(unclaimed(undefined)).toEqual([]);
});
