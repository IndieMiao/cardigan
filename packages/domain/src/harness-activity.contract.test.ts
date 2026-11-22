import { expect, test } from "vitest";
import {
  assignment,
  fixture,
  human,
  id,
  now,
  run,
} from "./commands/test-fixtures.js";
import {
  type HarnessActivity,
  runModelOutputTime,
} from "./harness-activity.js";

test("recovery accepts only model output attributable to the current Run and session generation", () => {
  const a = {
    ...assignment(),
    runtime_ref: {
      machine_id: "local",
      runtime_machine: "local",
      agent_name: "fixture",
      terminal_ref: "t1",
    },
  };
  const stamp = (seconds: number) =>
    new Date(Date.parse(now) + seconds * 1000).toISOString();
  const r = { ...run(), harness: "codex" as const, started_at: stamp(2) };
  const state = {
    ...fixture(),
    assignments: [a],
    runs: [r],
    events: [
      {
        id: r.trigger_event_id,
        actor: human,
        type: "session_replaced",
        payload: { assignment_id: a.id },
        created_at: stamp(4),
        seq: 1,
      },
    ],
  };
  const sample: HarnessActivity = {
    run_id: r.id,
    assignment_id: a.id,
    runtime_key: JSON.stringify(a.runtime_ref),
    session_id: "fixture-session",
    source: "codex:session_metadata",
    updated_at: stamp(9),
    last_progress_at: stamp(8),
    stale_after_ms: 60_000,
  };
  const time = (patch: Partial<HarnessActivity>) =>
    runModelOutputTime(state, a, r, stamp(10), { ...sample, ...patch });
  expect(time({})).toBeUndefined();
  expect(
    time({ model_output_at: stamp(6), error: "stream_disconnected" }),
  ).toBe(Date.parse(stamp(6)));
  for (const patch of [
    { source: "pi:session_metadata" },
    { session_id: "other" },
    { runtime_key: "old" },
    { run_id: id("run", 2) },
    { model_output_at: stamp(3) },
    { model_output_at: stamp(10) },
    { updated_at: stamp(11) },
  ])
    expect(time({ model_output_at: stamp(6), ...patch })).toBeUndefined();
  expect(
    runModelOutputTime({ ...state, events: [] }, a, r, stamp(10), {
      ...sample,
      model_output_at: stamp(1),
    }),
  ).toBeUndefined();
});
