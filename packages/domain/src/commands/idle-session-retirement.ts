import type { Actor, Assignment } from "../entities.js";
import type { AssignmentId } from "../ids.js";
import { sessionMaintenanceCandidate } from "../session-maintenance.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { stoppedByHuman } from "./stop.js";

export function beginIdleSessionRetirement(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  threshold: number,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may retire idle sessions",
    );
    const a = d.get("assignments", id);
    ensure(
      Number.isSafeInteger(threshold) &&
        threshold > 0 &&
        threshold <= 2147483647,
      "validation_failed",
      "Invalid idle threshold",
    );
    ensure(
      sessionMaintenanceCandidate(state, a, d.now, threshold).candidate &&
        a.runtime_ref,
      "illegal_transition",
      "Session is not an idle candidate",
    );
    const prior =
      a.idle_retirement &&
      JSON.stringify(a.idle_retirement.runtime_ref) ===
        JSON.stringify(a.runtime_ref)
        ? a.idle_retirement
        : undefined;
    const next: Assignment = {
      ...a,
      idle_retirement: {
        phase: "stopping",
        runtime_ref: a.runtime_ref,
        started_at: prior?.started_at ?? d.now,
        threshold_minutes: threshold,
        ...(a.last_mcp_activity_at
          ? { activity_at: a.last_mcp_activity_at }
          : {}),
        failures: prior?.failures ?? 0,
        ...(prior?.notice_sent ? { notice_sent: true } : {}),
      },
    };
    d.put("assignments", next);
    d.emit("idle_session_retirement_started", d.work(a.work_item_id!).card_id, {
      assignment_id: id,
    });
    return next;
  });
}

/** Host evidence only. Unknown outcomes retain the launch fence across restarts. */
export function settleIdleSessionRetirement(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  outcome: "exited" | "timeout" | "uncertain" | "withdrawn",
  retryMs: number,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may settle retirement",
    );
    const a = d.get("assignments", id),
      pending = a.idle_retirement;
    if (!pending || pending.phase !== "stopping") return a;
    ensure(
      JSON.stringify(a.runtime_ref) === JSON.stringify(pending.runtime_ref) ||
        (a.runtime_ref === null && stoppedByHuman(state.events, a.id)),
      "illegal_transition",
      "Retiring session changed",
    );
    ensure(
      Number.isSafeInteger(retryMs) && retryMs > 0 && retryMs <= 2147483647,
      "validation_failed",
      "Invalid retirement retry delay",
    );
    const card = d.work(a.work_item_id!).card_id;
    if (outcome === "exited" || outcome === "withdrawn") {
      const { idle_retirement: _retirement, ...identity } = a;
      if (outcome === "withdrawn") {
        const next: Assignment = identity;
        d.put("assignments", next);
        return next;
      }
      // A resumption may enqueue during shutdown, but the fence prevents dispatch.
      // Preserve that queued Run and its original launch snapshot for the new session.
      ensure(
        !state.runs.some(
          (r) =>
            r.assignment_id === id &&
            !["queued", "completed", "failed", "cancelled"].includes(r.status),
        ),
        "illegal_transition",
        "Retiring Assignment has new work",
      );
      const { session_ref: _session, ...rest } = identity;
      const next: Assignment = {
        ...rest,
        runtime_ref: null,
        runtime_state: ["unknown", "lost"].includes(a.runtime_state)
          ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
          : a.runtime_state === "running"
            ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
            : a.runtime_state,
      };
      d.put("assignments", next);
      d.emit("session_replaced", card, {
        assignment_id: id,
        reason: "idle_session_retired",
        handoff:
          "空闲会话已回收；保留身份、工作区和分支，下次合法唤醒创建新会话。",
      });
      return next;
    }
    const failures = pending.failures + 1;
    const notify = failures >= 3 && !pending.notice_sent;
    const next: Assignment = {
      ...a,
      idle_retirement: {
        ...pending,
        phase: outcome === "uncertain" ? "stopping" : "waiting",
        failures,
        retry_at: new Date(Date.parse(d.now) + retryMs).toISOString(),
        ...(pending.notice_sent || notify ? { notice_sent: true } : {}),
      },
    };
    d.put("assignments", next);
    if (notify)
      d.emit("session_maintenance_attention", card, {
        assignment_id: id,
        reason:
          outcome === "uncertain" ? "retirement_pending" : "retirement_timeout",
        notice: `${id} 空闲会话回收连续未确认退出；保留会话和凭据，请 PM 核查。`,
      });
    return next;
  });
}
