import { expect, test } from "vitest";
import type { Event } from "../entities.js";
import { markNoticesRead, notices } from "./notices.js";
import { apply, fixture, human, now, ports, value } from "./test-fixtures.js";

test.each([
  "launch_model_changed",
  "launch_reload_failed",
  "host_disk_space_low",
  "host_memory_pressure",
  // C-390: host maintenance began, timed out, ended or needs recovery.
  "host_maintenance_notice",
])("%s is a host-only, nonblocking notice with durable read state", (type) => {
  const state = fixture(),
    io = ports();
  const event: Event = {
    id: io.ids.nextEventId(),
    seq: 1,
    created_at: now,
    type,
    actor: { kind: "system", project_id: state.project_id },
    payload: { notice: "fixture" },
  };
  expect(notices({ ...state, events: [{ ...event, actor: human }] })).toEqual(
    [],
  );
  const next = { ...state, events: [event] };
  expect(notices(next)).toMatchObject([
    {
      id: event.id,
      decision_id: null,
      card_id: null,
      body: "fixture",
      read: false,
    },
  ]);
  const read = apply(
    next,
    value(markNoticesRead(next, human, { notice_ids: [event.id] }, io)),
  );
  expect(notices(read)[0]?.read).toBe(true);
  expect(read.decisions).toEqual(state.decisions);
});

test("C-390: maintenance audit events stay out of the notice list", () => {
  const state = fixture(),
    io = ports();
  const event: Event = {
    id: io.ids.nextEventId(),
    seq: 1,
    created_at: now,
    type: "host_maintenance_recorded",
    actor: human,
    payload: { maintenance_id: "M-1", phase: "draining", note: "fixture" },
  };
  expect(notices({ ...state, events: [event] })).toEqual([]);
  expect(
    notices({
      ...state,
      events: [
        { ...event, actor: { kind: "system", project_id: state.project_id } },
      ],
    }),
  ).toEqual([]);
});
