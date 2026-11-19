import type { CommandState } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  fixture,
  id,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardDetail, machineSelection } from "./read.js";

const at = (n: number) => `2026-11-18T00:00:0${n}.000Z`;
function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): CommandState["events"][number] {
  return {
    id: `0${String(seq).padStart(25, "0")}` as CommandState["events"][number]["id"],
    card_id: id("card", 1),
    seq,
    type,
    actor: { kind: "system", project_id: "p" },
    payload: payload as CommandState["events"][number]["payload"],
    created_at: at(seq),
  };
}
const item = id("work_item", 1);
const candidate = {
  machine_id: "local",
  affinity: false,
  control_host: true,
  limit: 12,
  occupied: 8,
  pending_assignments: 2,
  remaining_ratio: 1 / 3,
  preference_rank: null,
  resources: [{ key: "blender", limit: 2, occupied: 0 }],
};
const selected = event(3, "machine_selected", {
  work_item_id: item,
  assignment_id: id("assignment", 1),
  machine_id: "local",
  candidates: [candidate],
  excluded: [{ machine_id: "mac-mini", reasons: ["draining", "tag=gpu"] }],
  selection_order: ["control_host"],
});

test("MC-5 the newest placement wins: deferred, then automatic, then assigned", () => {
  const deferred = event(1, "system_assignment_deferred", {
    work_item_id: item,
    reason: "没有满足条件的机器",
    candidates: [{ employee_id: "E-1", reason: "x" }],
  });
  const assigned = event(2, "work_item_assigned", {
    work_item_id: item,
    assignment_id: id("assignment", 1),
    machine_id: "local",
  });
  expect(machineSelection([deferred], item)).toEqual({
    status: "deferred",
    at: at(1),
    reason: "没有满足条件的机器",
  });
  // Order of the array does not matter; the stream sequence does.
  expect(machineSelection([selected, assigned, deferred], item)).toEqual({
    status: "selected",
    at: at(3),
    machine_id: "local",
    assignment_id: id("assignment", 1),
    candidates: [
      {
        machine_id: "local",
        affinity: false,
        control_host: true,
        limit: 12,
        occupied: 8,
        pending_assignments: 2,
        remaining_ratio: 1 / 3,
        preference_rank: null,
        resources: [{ key: "blender", limit: 2, occupied: 0 }],
      },
    ],
    excluded: [{ machine_id: "mac-mini", reasons: ["draining", "tag=gpu"] }],
  });
  const explicit = event(4, "work_item_assigned", {
    work_item_id: item,
    assignment_id: id("assignment", 2),
    machine_id: "mac-mini",
  });
  expect(
    machineSelection([deferred, assigned, selected, explicit], item),
  ).toEqual({
    status: "assigned",
    at: at(4),
    machine_id: "mac-mini",
    assignment_id: id("assignment", 2),
  });
  expect(machineSelection([selected], id("work_item", 2))).toBeUndefined();
});

test("MC-5 card detail attaches the selection only to its own work item", () => {
  const state = fixture();
  const detail = cardDetail(
    { ...state, events: [...state.events, selected] },
    id("card", 1),
  );
  const [first, ...rest] = detail?.work_items ?? [];
  expect(first?.machine_selection).toMatchObject({
    status: "selected",
    machine_id: "local",
  });
  for (const other of rest)
    expect(other).not.toHaveProperty("machine_selection");
});

test("MC-5 a pre-MC-3 automatic assignment is not reported as an explicit choice", () => {
  // Before MC-3 the system auto-selected the single eligible machine and only
  // wrote work_item_assigned; the missing audit says nothing about the source.
  const legacy = event(1, "work_item_assigned", {
    work_item_id: item,
    assignment_id: id("assignment", 1),
    machine_id: "local",
    rule: "C-225/auto-assign",
    first_producer: true,
    assigned_by: "system",
    employee_id: "E-14",
  });
  expect(machineSelection([legacy], item)).toEqual({
    status: "assigned",
    at: at(1),
    machine_id: "local",
    assignment_id: id("assignment", 1),
  });
});

test("MC-5 the selection keeps the resource snapshot and drops malformed slots", () => {
  const bottleneck = event(5, "machine_selected", {
    work_item_id: item,
    assignment_id: id("assignment", 3),
    machine_id: "M1",
    candidates: [
      {
        machine_id: "M1",
        affinity: false,
        control_host: false,
        limit: 8,
        occupied: 1,
        remaining_ratio: 0,
        preference_rank: null,
        resources: [
          { key: "blender", limit: 1, occupied: 1 },
          { key: "bad", limit: "1", occupied: 0 },
          null,
        ],
      },
    ],
    excluded: [],
  });
  const result = machineSelection([bottleneck], item);
  expect(result?.status === "selected" && result.candidates).toEqual([
    {
      machine_id: "M1",
      affinity: false,
      control_host: false,
      limit: 8,
      occupied: 1,
      remaining_ratio: 0,
      preference_rank: null,
      resources: [{ key: "blender", limit: 1, occupied: 1 }],
    },
  ]);
});
