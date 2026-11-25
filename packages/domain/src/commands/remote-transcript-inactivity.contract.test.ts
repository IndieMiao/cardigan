import { expect, test } from "vitest";
import type { Event, Run, RuntimeRef } from "../entities.js";
import type { HarnessActivity } from "../harness-activity.js";
import type { EventId } from "../ids.js";
import { sessionMaintenanceCandidate } from "../session-maintenance.js";
import { openStartupFailure } from "../startup-failure.js";
import {
  obsoleteDispatchAttention,
  resolveDispatchAttention,
} from "./dispatch-recovery.js";
import {
  claimInactiveRunStop,
  DEFAULT_INACTIVE_CANCEL_AFTER_MS,
  inactiveStopEvidence,
  startInactiveRunStop,
} from "./inactive-run.js";
import { assignment, fixture, ports, run, value } from "./test-fixtures.js";

// C-752 regression, modelled on sensen C-155 A-399 / R-3420: a Claude Code
// session on a remote worker whose transcript is readable (file write time)
// but which never yields session metadata. Last progress 10:54Z, MCP silent.
const ref: RuntimeRef = {
  machine_id: "mac-mini",
  runtime_machine: "mac-mini",
  terminal_ref: "mac-mini/t1",
  agent_name: "fixture",
};
const started = "2026-11-25T10:30:00.000Z";
const lastRecord = "2026-11-25T10:54:00.000Z";
const lastWrite = "2026-11-25T10:54:20.000Z";
const system = { kind: "system" as const, project_id: fixture().project_id };

function scene(extra: { events?: Event[] } = {}) {
  const a = {
    ...assignment(),
    machine_id: "mac-mini",
    runtime_state: "running" as const,
    runtime_ref: ref,
    session_ref: "session-399",
    last_mcp_activity_at: "2026-11-25T10:53:00.000Z",
  };
  const r: Run = { ...run(), harness: "claude-code", started_at: started };
  const base = fixture();
  const state = {
    ...base,
    assignments: [a, ...base.assignments.filter((x) => x.id !== a.id)],
    runs: [r],
    events: extra.events ?? [],
  };
  const file: HarnessActivity = {
    assignment_id: a.id,
    run_id: r.id,
    runtime_key: JSON.stringify(ref),
    session_id: "session-399",
    updated_at: lastRecord,
    written_at: lastWrite,
    stale_after_ms: 600_000,
    source: "claude-code:transcript_mtime",
  };
  return { a, r, state, file };
}
const at = (now: string) => ({
  ...ports(),
  clock: { now: () => now },
});
const due = "2026-11-25T11:54:20.000Z";
const early = "2026-11-25T11:54:19.999Z";

function claim(
  s: ReturnType<typeof scene>,
  now: string,
  p: {
    harness_activity?: HarnessActivity | undefined;
    file_activity?: HarnessActivity | undefined;
  },
) {
  return value(
    claimInactiveRunStop(
      s.state,
      system,
      { run_id: s.r.id, after_ms: DEFAULT_INACTIVE_CANCEL_AFTER_MS, ...p },
      at(now),
    ),
  );
}

test("A-399: a remote Claude session with only transcript writes stops 60 minutes after its last write", () => {
  const s = scene();
  // Before the fix this returned undefined, so the stop could never be due.
  expect(inactiveStopEvidence(s.state, s.r, s.a, due)).toBeUndefined();
  expect(claim(s, early, { file_activity: s.file }).changes).toEqual([]);
  const effect = claim(s, due, { file_activity: s.file });
  expect(effect.data?.inactivity_stop?.runtime_ref).toEqual(ref);
  expect(
    effect.events.find((e) => e.type === "run_inactivity_stop_requested")
      ?.payload,
  ).toMatchObject({
    evidence: "transcript_write",
    last_activity_at: lastWrite,
  });
});

test("MCP silence alone, or a write that cannot be tied to this Run, terminal and session, never stops", () => {
  const s = scene();
  const { written_at: _written, ...noWrite } = s.file;
  for (const file of [
    undefined,
    noWrite,
    { ...s.file, run_id: run(9).id },
    { ...s.file, runtime_key: "previous terminal" },
    { ...s.file, session_id: "other-session" },
    { ...s.file, source: "codex:transcript_mtime" },
    { ...s.file, error: "server_error" as const },
    // A record from before this Run started is not this Run's progress.
    { ...s.file, updated_at: "2026-11-25T10:00:00.000Z" },
    // A write time from the future (clock skew) is not evidence either.
    { ...s.file, written_at: "2026-11-25T12:30:00.000Z" },
  ])
    expect(
      claim(s, "2026-11-25T13:00:00.000Z", { file_activity: file }).changes,
    ).toEqual([]);
});

test("a later write of any record delays the stop; the newer of metadata and write wins", () => {
  const s = scene();
  const written = { ...s.file, written_at: "2026-11-25T11:20:00.000Z" };
  expect(claim(s, due, { file_activity: written }).changes).toEqual([]);
  const metadata: HarnessActivity = {
    ...s.file,
    source: "claude-code:session_metadata",
    updated_at: "2026-11-25T11:30:00.000Z",
  };
  delete (metadata as { written_at?: string }).written_at;
  expect(
    claim(s, "2026-11-25T12:29:59.000Z", {
      harness_activity: metadata,
      file_activity: s.file,
    }).changes,
  ).toEqual([]);
  expect(
    claim(s, "2026-11-25T12:30:00.000Z", {
      harness_activity: metadata,
      file_activity: s.file,
    }).events.find((e) => e.type === "run_inactivity_stop_requested")?.payload,
  ).toMatchObject({ evidence: "session_metadata" });
});

test("upstream fault: a current error without verified progress is never overridden by an old transcript write", () => {
  const s = scene();
  const failing: HarnessActivity = {
    ...s.file,
    source: "claude-code:session_metadata",
    updated_at: "2026-11-25T11:00:00.000Z",
    error: "server_error",
  };
  delete (failing as { written_at?: string }).written_at;
  expect(
    claim(s, "2026-11-25T13:00:00.000Z", {
      harness_activity: failing,
      file_activity: s.file,
    }).changes,
  ).toEqual([]);
});

test("a managed host operation in progress holds the stop even with transcript evidence", () => {
  const taken: Event = {
    id: "0".repeat(25).concat("9") as EventId,
    seq: 1,
    type: "host_ops_action_taken",
    actor: system,
    payload: {
      execution: true,
      assignment_id: assignment().id,
      tool: "host_ops_restart_assignment",
    },
    created_at: "2026-11-25T11:00:00.000Z",
  };
  const s = scene({ events: [taken] });
  expect(claim(s, due, { file_activity: s.file }).changes).toEqual([]);
});

test("the pre-release recheck withdraws on a fresh transcript write", () => {
  const s = scene();
  const fenced = claim(s, due, { file_activity: s.file });
  const r = fenced.data;
  if (!r?.inactivity_stop) throw new Error("expected a stop fence");
  const state = { ...s.state, runs: [r] };
  const withdrawn = value(
    startInactiveRunStop(
      state,
      system,
      {
        run_id: r.id,
        attempt_id: r.inactivity_stop.attempt_id,
        after_ms: DEFAULT_INACTIVE_CANCEL_AFTER_MS,
        file_activity: { ...s.file, written_at: "2026-11-25T11:54:10.000Z" },
      },
      at(due),
    ),
  );
  expect(withdrawn.data).toBeUndefined();
  expect(withdrawn.events.map((e) => e.type)).toEqual([
    "run_inactivity_stop_withdrawn",
  ]);
  const started = value(
    startInactiveRunStop(
      state,
      system,
      {
        run_id: r.id,
        attempt_id: r.inactivity_stop.attempt_id,
        after_ms: DEFAULT_INACTIVE_CANCEL_AFTER_MS,
        file_activity: s.file,
      },
      at(due),
    ),
  );
  expect(started.data?.inactivity_stop?.stopping).toBe(true);
});

// C-140 A-355: two `mcp_unavailable` startup failures, no further requeue.
function startupFailure() {
  const a = {
    ...assignment(),
    runtime_state: "idle" as const,
    runtime_ref: ref,
    last_mcp_activity_at: "2026-11-25T08:00:00.000Z",
  };
  const failed = {
    ...run(),
    status: "cancelled" as const,
    outcome: "failed" as const,
    finished_at: "2026-11-25T08:10:00.000Z",
  };
  const stalled: Event = {
    id: "0".repeat(25).concat("7") as EventId,
    seq: 1,
    type: "run_dispatch_stalled",
    actor: system,
    payload: {
      assignment_id: a.id,
      run_id: failed.id,
      reason: "mcp_unavailable",
      audience: "pm_ops",
    },
    created_at: "2026-11-25T08:10:00.000Z",
  };
  const base = fixture();
  const state = {
    ...base,
    assignments: [a, ...base.assignments.filter((x) => x.id !== a.id)],
    runs: [failed],
    events: [stalled],
  };
  const note = {
    id: "n-1",
    project_id: state.project_id,
    event_id: stalled.id,
    recipient: { kind: "pm_ops" as const },
    seq: 1,
    kind: "run_attention",
    status: "pending" as const,
    attempts: 0,
    created_at: stalled.created_at,
    updated_at: stalled.created_at,
  };
  return { a, failed, state, note, stalled };
}

test("C-140: a session that never reached the Card tools stays open until it recovers or the Assignment is released", () => {
  const t = startupFailure();
  expect(openStartupFailure(t.state, t.a)).toBe(true);
  expect(obsoleteDispatchAttention(t.state, t.note)).toBe(false);
  // Reading the attention is not handling it.
  expect(
    obsoleteDispatchAttention(t.state, { ...t.note, status: "belled" }),
  ).toBe(false);
  const recovered = {
    ...t.state,
    runs: [t.failed, { ...run(5, 1), started_at: "2026-11-25T09:00:00.000Z" }],
  };
  expect(obsoleteDispatchAttention(recovered, t.note)).toBe(true);
  expect(openStartupFailure(recovered, t.a)).toBe(false);
  const released = {
    ...t.state,
    assignments: [
      { ...t.a, status: "released" as const },
      ...t.state.assignments.slice(1),
    ],
  };
  expect(obsoleteDispatchAttention(released, t.note)).toBe(true);
});

test("C-140: the human action for an unhandled startup failure is not auto-closed", () => {
  const t = startupFailure();
  const requested: Event = {
    id: "0".repeat(25).concat("8") as EventId,
    seq: 2,
    type: "human_action_requested",
    actor: system,
    payload: {
      human_action_id: "H-1",
      dispatch_run_id: t.failed.id,
      dispatch_reason: "mcp_unavailable",
    },
    created_at: t.stalled.created_at,
  };
  const action = {
    id: "H-1",
    key: "H-1",
    requested_by: "system",
    status: "open",
    blocked_work_items: [],
    instructions: "restart",
    why_human: "fixture",
    expected_return: "fixture",
  } as unknown as (typeof t.state.human_actions)[number];
  const state = {
    ...t.state,
    events: [...t.state.events, requested],
    human_actions: [action],
  };
  expect(
    value(resolveDispatchAttention(state, system, ports())).changes,
  ).toEqual([]);
  const recovered = {
    ...state,
    runs: [t.failed, { ...run(5, 1), started_at: "2026-11-25T09:00:00.000Z" }],
  };
  expect(
    value(resolveDispatchAttention(recovered, system, ports())).events.map(
      (e) => e.type,
    ),
  ).toEqual(["dispatch_attention_resolved"]);
});

test("C-140: idle session retirement leaves an open startup failure to its report", () => {
  const t = startupFailure();
  const now = "2026-11-25T12:00:00.000Z";
  expect(sessionMaintenanceCandidate(t.state, t.a, now)).toEqual({
    reason: "startup_failure_pending",
    candidate: false,
  });
  const other = {
    ...t.state,
    events: [
      {
        ...t.stalled,
        payload: { ...(t.stalled.payload as object), reason: "server_restart" },
      },
    ],
  };
  expect(sessionMaintenanceCandidate(other, t.a, now).reason).not.toBe(
    "startup_failure_pending",
  );
});
