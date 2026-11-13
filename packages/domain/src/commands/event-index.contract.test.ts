import { expect, test } from "vitest";
import {
  type Event,
  eventById,
  hostOpsPending,
  type JsonValue,
  parseEventId,
  pendingHostOpsActions,
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
