import { expect, test } from "vitest";
import {
  claimDispatchStop,
  type HarnessActivity,
  providerStartFailed,
  startDispatchStop,
} from "../index.js";
import {
  commit,
  dispatch,
  f,
  item,
  queue,
  ref,
  setup,
  system,
} from "./launch/test-fixtures.js";

test("C-499: startup classification needs bound, post-dispatch fault evidence and cannot consume a late model or MCP turn", () => {
  setup();
  const queued = commit(queue());
  f.state = { ...f.state, runs: [{ ...queued, launch_profile_ref: "relay" }] };
  const run = commit(dispatch(queued));
  const at = f.io.clock.now();
  const ms = Date.parse(at);
  f.io = { ...f.io, clock: { now: () => new Date(ms + 100).toISOString() } };
  const sample: HarnessActivity = {
    assignment_id: f.coder.id,
    run_id: run.id,
    runtime_key: JSON.stringify(ref),
    session_id: "session-1",
    source: "codex:session_metadata",
    updated_at: at,
    model_silent_since: 0,
    error: "server_error",
    stale_after_ms: 100,
  };
  const failed = (s: HarnessActivity) =>
    providerStartFailed(f.state, run, s, f.io.clock.now(), 100);
  expect(failed(sample)).toBe(true);
  for (const change of [
    { session_id: "another" },
    { runtime_key: "old" },
    { error: "unclassified" as const },
    { updated_at: new Date(ms + 101).toISOString() },
    { model_silent_since: ms },
    { updated_at: new Date(ms - 1).toISOString() },
  ])
    expect(failed({ ...sample, ...change })).toBe(false);
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        reason: "provider_unavailable",
        provider_sample: sample,
        timeout_ms: 100,
        lease_ms: 100,
      },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) throw new Error("missing fence");
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, last_mcp_activity_at: at } : a,
    ),
  };
  expect(
    commit(
      startDispatchStop(
        f.state,
        system,
        {
          run_id: run.id,
          attempt_id: claimed.dispatch_stop.attempt_id,
          provider_sample: sample,
          timeout_ms: 100,
        },
        f.io,
      ),
    ),
  ).toBe(false);
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
  expect(item().status).not.toBe("in_progress");
});
