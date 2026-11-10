import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
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

// C-54#19: a legitimate Run stayed silent for 48 minutes. Two hours gives
// more than twice that observed interval; the 15-minute alert is not a kill deadline.
export const DEFAULT_INACTIVE_CANCEL_AFTER_MS = 120 * 60_000;
export const INACTIVE_STOP_LEASE_MS = 60_000;
const ended = (run: Run) =>
  ["completed", "failed", "cancelled"].includes(run.status);
const sameRef = (a: RuntimeRef | null, b: RuntimeRef) =>
  JSON.stringify(a) === JSON.stringify(b);
const cardOf = (d: CommandDraft, a: Assignment) =>
  a.scope === "work_item"
    ? d.get("work_items", a.work_item_id).card_id
    : undefined;

export function lastRunActivity(run: Run, assignment: Assignment): number {
  return Math.max(
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
export function inactiveRunDue(
  run: Run,
  assignment: Assignment,
  now: string,
  afterMs: number,
): boolean {
  return (
    run.status === "running" &&
    assignment.status === "active" &&
    assignment.runtime_ref !== null &&
    Number.isSafeInteger(afterMs) &&
    afterMs > 0 &&
    Number.isFinite(lastRunActivity(run, assignment)) &&
    Date.parse(now) - lastRunActivity(run, assignment) >= afterMs
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
  p: { run_id: RunId; after_ms: number },
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
    const old = run.inactivity_stop;
    if (old && old.lease_until > d.now) return undefined;
    if (old && !sameRef(a.runtime_ref, old.runtime_ref))
      return clear(d, run, "runtime_changed");
    if (!old && !inactiveRunDue(run, a, d.now, p.after_ms)) return undefined;
    if (old && !old.stopping && !inactiveRunDue(run, a, d.now, p.after_ms))
      return clear(d, run, "activity_resumed");
    const ref = old?.runtime_ref ?? a.runtime_ref;
    if (!ref) return undefined;
    const event = d.emit("run_inactivity_stop_requested", cardOf(d, a), {
      run_id: run.id,
      after_ms: p.after_ms,
      retry: !!old,
      last_activity_at: new Date(lastRunActivity(run, a)).toISOString(),
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

/** Recheck fresh MCP activity immediately before the host calls Runtime.release. */
export function startInactiveRunStop(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; attempt_id: string; after_ms: number },
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
    const due = stop.stopping
      ? Number.isFinite(lastRunActivity(run, a)) &&
        Date.parse(d.now) - lastRunActivity(run, a) >= p.after_ms
      : inactiveRunDue(run, a, d.now, p.after_ms);
    if (!due) {
      // Once release has been attempted it may still complete late. Keep the
      // fence until exit is confirmed; fresh activity prevents another kill.
      return stop.stopping ? undefined : clear(d, run, "activity_resumed");
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
      ? {
          ...previous,
          status: unwrap(transition("run", run.status, "cancel")),
          outcome: "failed",
          summary: "MCP 长期无活动；主机确认终端退出后自动取消 Run",
          finished_at: d.now,
        }
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
