import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
import {
  associatedHarnessActivity,
  currentHarnessActivity,
  type HarnessActivity,
  harnessActivityTime,
} from "../harness-activity.js";
import { hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { cancelRunDispatch } from "./launch.js";

// Q-88 explicitly selects 60 minutes despite observed legitimate silence of
// 48 minutes. The 15-minute alert remains separate from this configurable deadline.
export const DEFAULT_INACTIVE_CANCEL_AFTER_MS = 60 * 60_000;
export const INACTIVE_STOP_LEASE_MS = 60_000;
const ended = (run: Run) =>
  ["completed", "failed", "cancelled"].includes(run.status);
const sameRef = (a: RuntimeRef | null, b: RuntimeRef) =>
  JSON.stringify(a) === JSON.stringify(b);
const cardOf = (d: CommandDraft, a: Assignment) =>
  a.scope === "work_item"
    ? d.get("work_items", a.work_item_id).card_id
    : undefined;

export function lastRunActivity(
  run: Run,
  assignment: Assignment,
  harnessAt?: number,
): number {
  return Math.max(
    harnessAt ?? Number.NEGATIVE_INFINITY,
    ...[
      run.started_at,
      run.heartbeat_at,
      assignment.last_mcp_activity_at,
      assignment.created_at,
    ].flatMap((at) =>
      at && Number.isFinite(Date.parse(at)) ? [Date.parse(at)] : [],
    ),
  );
}
/** No stop deadline exists for Claude without a sample from this Run/session. */
export function lastInactiveStopActivity(
  state: CommandState,
  run: Run,
  assignment: Assignment,
  now: string,
  sample?: HarnessActivity,
): number | undefined {
  if (run.harness === "claude-code") {
    const associated = associatedHarnessActivity(
      state,
      assignment,
      now,
      sample,
    );
    if (
      associated?.source !== "claude-code:session_metadata" ||
      associated.run_id !== run.id
    )
      return;
    return lastRunActivity(run, assignment, harnessActivityTime(associated));
  }
  return lastRunActivity(
    run,
    assignment,
    harnessActivityTime(currentHarnessActivity(state, assignment, now, sample)),
  );
}
export function inactiveRunDue(
  run: Run,
  assignment: Assignment,
  now: string,
  afterMs: number,
  lastActivity: number | undefined,
): boolean {
  return (
    run.status === "running" &&
    assignment.status === "active" &&
    assignment.runtime_ref !== null &&
    Number.isSafeInteger(afterMs) &&
    afterMs > 0 &&
    lastActivity !== undefined &&
    Number.isFinite(lastActivity) &&
    Date.parse(now) - lastActivity >= afterMs
  );
}
function clear(d: CommandDraft, run: Run, reason: string) {
  const next = { ...run };
  delete next.inactivity_stop;
  d.put("runs", next);
  const a = d.get("assignments", run.assignment_id);
  d.emit("run_inactivity_stop_withdrawn", cardOf(d, a), {
    run_id: run.id,
    reason,
  });
  return undefined;
}

/** System-only durable fence. Claim/retry never frees capacity or revokes credentials. */
export function claimInactiveRunStop(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    after_ms: number;
    harness_activity?: HarnessActivity | undefined;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_inactive_run_stop", ports, (d) => {
    ensure(
      Number.isSafeInteger(p.after_ms) && p.after_ms > 0,
      "validation_failed",
      "Invalid inactivity grace",
    );
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id);
    const lastActivity = lastInactiveStopActivity(
      state,
      run,
      a,
      d.now,
      p.harness_activity,
    );
    if (hostOpsPending(state.events, a.id)) return;
    if (run.dispatch_stop) return undefined;
    const old = run.inactivity_stop;
    if (old && old.lease_until > d.now) return undefined;
    if (old && !sameRef(a.runtime_ref, old.runtime_ref))
      return clear(d, run, "runtime_changed");
    if (
      !old?.stopping &&
      !inactiveRunDue(run, a, d.now, p.after_ms, lastActivity)
    )
      return old
        ? clear(
            d,
            run,
            lastActivity === undefined
              ? "activity_unknown"
              : "activity_resumed",
          )
        : undefined;
    const ref = old?.runtime_ref ?? a.runtime_ref;
    if (!ref) return undefined;
    const event = d.emit("run_inactivity_stop_requested", cardOf(d, a), {
      run_id: run.id,
      after_ms: p.after_ms,
      retry: !!old,
      last_activity_at: new Date(
        lastActivity ?? lastRunActivity(run, a),
      ).toISOString(),
    });
    const next: Run = {
      ...run,
      inactivity_stop: {
        attempt_id: event.id,
        runtime_ref: ref,
        stopping: old?.stopping ?? false,
        lease_until: new Date(
          Date.parse(d.now) + INACTIVE_STOP_LEASE_MS,
        ).toISOString(),
      },
    };
    d.put("runs", next);
    return next;
  });
}

/** Recheck fresh MCP and harness activity immediately before the host calls Runtime.release. */
export function startInactiveRunStop(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    attempt_id: string;
    after_ms: number;
    harness_activity?: HarnessActivity | undefined;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_inactive_run_stop", ports, (d) => {
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id),
      stop = run.inactivity_stop;
    if (!stop || stop.attempt_id !== p.attempt_id || stop.lease_until <= d.now)
      return undefined;
    if (!sameRef(a.runtime_ref, stop.runtime_ref))
      return clear(d, run, "runtime_changed");
    ensure(
      Number.isSafeInteger(p.after_ms) && p.after_ms > 0,
      "validation_failed",
      "Invalid inactivity grace",
    );
    const lastActivity = lastInactiveStopActivity(
      state,
      run,
      a,
      d.now,
      p.harness_activity,
    );
    const due = stop.stopping
      ? lastActivity !== undefined &&
        Number.isFinite(lastActivity) &&
        Date.parse(d.now) - lastActivity >= p.after_ms
      : inactiveRunDue(run, a, d.now, p.after_ms, lastActivity);
    if (!due) {
      // Once release has been attempted it may still complete late. Keep the
      // fence until exit is confirmed; fresh activity prevents another kill.
      return stop.stopping
        ? undefined
        : clear(
            d,
            run,
            lastActivity === undefined
              ? "activity_unknown"
              : "activity_resumed",
          );
    }
    const next: Run = { ...run, inactivity_stop: { ...stop, stopping: true } };
    d.put("runs", next);
    if (!stop.stopping)
      d.emit("run_inactivity_stop_started", cardOf(d, a), {
        run_id: run.id,
        attempt_id: stop.attempt_id,
      });
    return next;
  });
}

/** The host must prove exit for this exact reference. Never turn a stop into success. */
export function finishInactiveRunStop(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    attempt_id: string;
    runtime_ref: RuntimeRef;
    exited: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_inactive_run_stop", ports, (d) => {
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id),
      stop = run.inactivity_stop;
    if (!stop || stop.attempt_id !== p.attempt_id) return undefined;
    ensure(
      stop.stopping,
      "illegal_transition",
      "A fresh inactivity check must precede stop completion",
    );
    ensure(
      p.exited && sameRef(p.runtime_ref, stop.runtime_ref),
      "validation_failed",
      "Runtime exit must be confirmed for the stopped session",
    );
    if (!sameRef(a.runtime_ref, stop.runtime_ref))
      return clear(d, run, "runtime_changed");
    const cancelled = !ended(run);
    const { inactivity_stop: _stop, ...previous } = run;
    const next: Run = cancelled
      ? cancelRunDispatch(
          d,
          previous,
          "MCP 与可用会话证据长期无活动；主机确认终端退出后自动取消 Run",
        )
      : previous;
    d.put("runs", next);
    // Unknown/lost retains the old reference so the existing replacement path
    // can recover it. Idle/running sessions can start fresh after this fence ends.
    if (["running", "idle"].includes(a.runtime_state))
      d.put("assignments", {
        ...a,
        runtime_state:
          a.runtime_state === "running"
            ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
            : a.runtime_state,
        runtime_ref: null,
      });
    const body = cancelled
      ? "失活回收：已确认终端退出，自动取消 Run（失败），保留工作项与工作树。"
      : "失活回收期间 Run 已结束；保留原结果，已确认旧终端退出。";
    d.emit(
      "run_inactivity_stop_finished",
      cardOf(d, a),
      { run_id: run.id, assignment_id: a.id, cancelled, outcome: next.outcome },
      {
        type: "system",
        body,
        run_id: run.id,
        ...(a.scope === "work_item" ? { work_item_id: a.work_item_id } : {}),
      },
    );
    return next;
  });
}
