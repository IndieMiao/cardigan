import { expect, test, vi } from "vitest";
import {
  type Event,
  type Precheck,
  prechecks,
  projectSnapshot,
} from "../index.js";
import { fixture, human, id, now, value } from "./test-fixtures.js";

function event(
  seq: number,
  card = 1,
  attempt = "first",
  status: Precheck["status"] = "queued",
): Event {
  const check: Precheck = {
    attempt_id: attempt,
    card_id: id("card", card),
    assignment_id: id("assignment", 1),
    work_item_id: id("work_item", 1),
    head_sha: "a".repeat(40),
    status,
    branch: "synthetic",
    machine_id: "synthetic",
  };
  return {
    id: String(seq).padStart(26, "0") as Event["id"],
    seq,
    card_id: check.card_id,
    type: status === "queued" ? "precheck_queued" : "precheck_finished",
    actor: { kind: "system", project_id: human.project_id },
    created_at: now,
    payload: JSON.parse(JSON.stringify(check)),
  };
}

// Explicit expected records exercise the old sort/filter/last-attempt contract,
// including seq ties across card streams and untrusted/mismatched observations.
test("precheck projection preserves stream ordering and trusted card boundaries", () => {
  const queued = event(1);
  const passed = event(3, 1, "first", "passed");
  const other = event(3, 2, "first", "failed");
  const second = event(2, 1, "second");
  const events = [
    passed,
    other,
    queued,
    second,
    { ...event(4), actor: human },
    { ...event(5), card_id: id("card", 2) },
    { ...event(6), type: "comment_posted" },
    { ...event(7), payload: null },
  ];
  expect(prechecks(events, id("card", 1))).toEqual([
    passed.payload,
    second.payload,
  ]);
  expect(prechecks(events, id("card", 2))).toEqual([other.payload]);
  expect(prechecks(events)).toEqual([other.payload, second.payload]);
  expect(prechecks(events, id("card", 3))).toEqual([]);
  expect(events[0]).toBe(passed);
  prechecks(events).pop();
  expect(prechecks(events)).toHaveLength(2);
});

test("new snapshots invalidate prechecks without changing rolled-back or foreign snapshots", () => {
  const queued = event(1);
  const original = Object.freeze([queued]);
  const changed = Object.freeze([...original, event(2, 1, "first", "passed")]);
  const foreign = Object.freeze([
    {
      ...event(1, 1, "foreign"),
      actor: { kind: "system" as const, project_id: "foreign" },
    },
  ]);
  expect(prechecks(original)[0]?.status).toBe("queued");
  expect(prechecks(changed)[0]?.status).toBe("passed");
  expect(prechecks(original)[0]?.status).toBe("queued");
  expect(prechecks(foreign)[0]?.attempt_id).toBe("foreign");
});

test("all-card reads scan the event snapshot once and still authenticate each caller", () => {
  const base = fixture();
  const events = [event(1), event(2, 2, "other", "failed")];
  const filter = vi.spyOn(events, "filter");
  for (const card of [1, 2, 3, 1]) prechecks(events, id("card", card));
  expect(filter).toHaveBeenCalledTimes(1);
  filter.mockRestore();
  const card = base.cards[0];
  if (!card) throw new Error("Missing fixture card");
  const state = {
    ...base,
    events,
    cards: [card, { ...card, id: id("card", 2) }],
  };
  const snapshot = value(projectSnapshot(state, human)).data;
  expect(snapshot.cards.map((c) => c.prechecks)).toEqual([
    [expect.objectContaining({ attempt_id: "first", status: "queued" })],
    [expect.objectContaining({ attempt_id: "other", status: "failed" })],
  ]);
  expect(
    projectSnapshot(state, { ...human, project_id: "foreign" }),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});
