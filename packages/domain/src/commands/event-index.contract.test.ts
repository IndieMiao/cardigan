import { expect, test } from "vitest";
import {
  type Event,
  eventById,
  eventsOfType,
  hostOpsPending,
  type JsonValue,
  parseEventId,
  pendingHostOpsActions,
  stoppedByHuman,
} from "../index.js";
import { human, id, now, value } from "./test-fixtures.js";

const eventId = (n: number) =>
  value(parseEventId(n.toString().padStart(26, "0")));

function event(n: number, type: string, payload: JsonValue = {}): Event {
  return {
    id: eventId(n),
    seq: n,
    type,
    actor: human,
    payload,
    created_at: now,
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

test("C-415: type indexes preserve order, duplicate IDs and snapshot isolation", () => {
  const before = Object.freeze([
    event(3, "run_started"),
    event(1, "__proto__", null),
    event(3, "run_started", { assignment_id: "A-2" }),
    event(2, "other"),
  ]);
  for (const type of ["run_started", "__proto__", "other", "absent"])
    expect(eventsOfType(before, type)).toEqual(
      before.filter((e) => e.type === type),
    );
  const after = [...before, event(4, "run_started")];
  expect(eventsOfType(after, "run_started")).toHaveLength(3);
  expect(eventsOfType(before, "run_started")).toHaveLength(2);
  const otherProject = [event(3, "other")];
  expect(eventsOfType(otherProject, "run_started")).toEqual([]);
  expect(eventsOfType([...before].reverse(), "run_started")).toEqual([
    before[2],
    before[0],
  ]);
});

test("C-424: stopped owners follow last array occurrence across snapshots and rollback", () => {
  const a = id("assignment", 1);
  const b = id("assignment", 2);
  const before = [
    event(100, "assignment_stopped", { assignment_id: a }),
    event(1, "run_dispatched", { assignment_id: a }),
    event(3, "assignment_stopped", { assignment_id: b }),
    event(4, "run_dispatched", null),
    event(5, "noise", { assignment_id: b }),
  ];
  for (const events of [before, [...before].reverse()]) {
    for (const owner of [a, b, id("assignment", 3)]) {
      const last = events.findLast(
        (e) =>
          ["assignment_stopped", "run_dispatched"].includes(e.type) &&
          (e.payload as { assignment_id?: string } | null)?.assignment_id ===
            owner,
      );
      expect(stoppedByHuman(events, owner)).toBe(
        last?.type === "assignment_stopped",
      );
    }
  }
  const after = [
    ...before,
    event(0, "assignment_stopped", { assignment_id: a }),
  ];
  expect(stoppedByHuman(after, a)).toBe(true);
  expect(stoppedByHuman(before, a)).toBe(false);
  expect(stoppedByHuman([], a)).toBe(false);
});

test("C-415: repeated timer queries do not rescan unchanged event history", () => {
  let reads = 0;
  const events = Array.from({ length: 2000 }, (_, i) => ({
    ...event(i + 1, "unused"),
    get type() {
      reads++;
      return i % 2 ? "run_started" : "other";
    },
  }));
  expect(eventsOfType(events, "run_started")).toHaveLength(1000);
  const initialReads = reads;
  for (const type of ["other", "run_started", "absent"])
    eventsOfType(events, type);
  expect(reads).toBe(initialReads);
});

/** Random host-ops histories, including duplicate ids and finished actions. */
function randomEvents(seed: number): Event[] {
  const pick = rng(seed);
  const events: Event[] = [];
  for (let i = 1, count = pick(30); i <= count; i++) {
    const n = pick(6) === 0 ? 1 + pick(i) : i;
    const kind = pick(4);
    events.push(
      kind === 0
        ? event(n, "host_ops_action_taken", {
            execution: pick(3) !== 0,
            assignment_id: id("assignment", 1 + pick(5)),
          })
        : kind === 1
          ? event(n, "host_ops_action_finished", {
              action_id: eventId(1 + pick(count + 1)),
            })
          : kind === 2
            ? event(n, "host_ops_action_taken", { execution: true })
            : event(n, "comment_posted"),
    );
  }
  return events;
}

test("C-221: keyed event lookup and host-ops memo match the linear scans", () => {
  let pending = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const events = randomEvents(seed);
    for (let n = 0; n <= events.length + 2; n++) {
      const key = eventId(n);
      expect(eventById(events, key)).toBe(events.find((e) => e.id === key));
    }
    expect(eventById(events, undefined)).toBeUndefined();
    for (let a = 1; a <= 6; a++) {
      const assignment = id("assignment", a);
      const expected = pendingHostOpsActions(events).some(
        (x) => x.assignment_id === assignment,
      );
      if (expected) pending++;
      expect(hostOpsPending(events, assignment), `seed ${seed}`).toBe(expected);
      expect(hostOpsPending(events, assignment)).toBe(expected);
    }
  }
  expect(pending).toBeGreaterThan(100);
});

test("C-221: an appended snapshot is re-indexed and the earlier snapshot keeps its answer", () => {
  const assignment = id("assignment", 1);
  const taken = event(1, "host_ops_action_taken", {
    execution: true,
    assignment_id: assignment,
  });
  const before: readonly Event[] = [taken];
  expect(hostOpsPending(before, assignment)).toBe(true);
  expect(eventById(before, eventId(2))).toBeUndefined();

  const finished = event(2, "host_ops_action_finished", {
    action_id: taken.id,
  });
  const after: readonly Event[] = [...before, finished];
  expect(hostOpsPending(after, assignment)).toBe(false);
  expect(eventById(after, eventId(2))).toBe(finished);

  // A rolled-back transaction reads the earlier array again.
  expect(hostOpsPending(before, assignment)).toBe(true);
  expect(eventById(before, eventId(2))).toBeUndefined();
});

test("C-319: decision index preserves source order, malformed payloads and immutable snapshot isolation", async () => {
  const { eventsForDecision } = await import("../event-index.js");
  const events = [
    event(3, "decision_requested", { decision_id: "Q-1" }),
    event(1, "decision_requested", { decision_id: "Q-2" }),
    event(2, "decision_resolved", { decision_id: "Q-1" }),
    event(4, "noise", null),
    event(5, "noise", ["Q-1"]),
  ];
  expect(eventsForDecision(events, "Q-1")).toEqual([events[0], events[2]]);
  expect(eventsForDecision(events, "missing")).toEqual([]);
  const next = [
    ...events,
    event(6, "decision_requested", { decision_id: "Q-1" }),
  ];
  expect(eventsForDecision(next, "Q-1")).toHaveLength(3);
  expect(eventsForDecision(events, "Q-1")).toHaveLength(2);
  expect(eventsForDecision([...events].reverse(), "Q-1")).toEqual([
    events[2],
    events[0],
  ]);
});
