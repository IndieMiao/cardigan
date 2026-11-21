import type { Actor, Assignment } from "../entities.js";
import type { AssignmentId } from "../ids.js";
import {
  type RetirementSettlement,
  retirementObserveOnly,
  retirementReasons,
} from "../runtime-types.js";
import {
  retirementOwnsSession,
  sessionMaintenanceCandidate,
} from "../session-maintenance.js";
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
    const prior = retirementOwnsSession(a) ? a.idle_retirement : undefined;
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
        ...(prior?.phase === "waiting" &&
        prior.last_failure === "unavailable" &&
        prior.evidence &&
        retirementObserveOnly(prior.evidence)
          ? { observe_only: true, evidence: prior.evidence }
          : {}),
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
  result: RetirementSettlement,
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
      retirementOwnsSession(a) ||
        (a.runtime_ref === null && stoppedByHuman(state.events, a.id)),
      "illegal_transition",
      "Retiring session changed",
    );
    ensure(
      Number.isSafeInteger(retryMs) && retryMs > 0 && retryMs <= 2147483647,
      "validation_failed",
      "Invalid retirement retry delay",
    );
    ensure(
      result.outcome !== "observing" || pending.observe_only === true,
      "illegal_transition",
      "Signal-capable retirement cannot release its fence by observation alone",
    );
    const card = d.work(a.work_item_id!).card_id;
    const { idle_retirement: _retirement, ...identity } = a;
    if (result.outcome === "withdrawn") {
      // The final signal guard may have withdrawn because business work arrived.
      // Decide in this settlement transaction whether there is a failure to retry.
      const retry = sessionMaintenanceCandidate(
        state,
        identity,
        d.now,
        pending.threshold_minutes,
      ).candidate;
      d.emit("idle_session_retirement_withdrawn", card, {
        assignment_id: id,
        machine_id: a.machine_id,
        evidence: result.evidence,
        retry,
      });
      if (!retry) {
        const next: Assignment = identity;
        d.put("assignments", next);
        return next;
      }
    }
    if (result.outcome === "exited") {
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
    const { evidence } = result;
    const outcome =
      result.outcome === "withdrawn" || result.outcome === "observing"
        ? "unavailable"
        : result.outcome;
    const failures = pending.failures + 1;
    const notify = failures >= 3 && !pending.notice_sent;
    const next: Assignment = {
      ...a,
      idle_retirement: {
        ...pending,
        phase: outcome === "uncertain" ? "stopping" : "waiting",
        last_failure: outcome,
        evidence,
        failures,
        retry_at: new Date(Date.parse(d.now) + retryMs).toISOString(),
        ...(pending.notice_sent || notify ? { notice_sent: true } : {}),
      },
    };
    d.put("assignments", next);
    if (notify) {
      const facts = [
        evidence.stage,
        evidence.terminal_state,
        evidence.hc_kind,
        evidence.runtime_code,
        evidence.exit_code === undefined
          ? undefined
          : `exit=${evidence.exit_code}`,
        evidence.observation,
      ]
        .filter((v) => v !== undefined)
        .join(" / ");
      const nextStep =
        outcome === "uncertain" || retirementObserveOnly(evidence)
          ? "只复查退出，不重发信号"
          : "系统退避重试";
      d.emit("session_maintenance_attention", card, {
        assignment_id: id,
        reason:
          outcome === "uncertain"
            ? "retirement_pending"
            : outcome === "unavailable"
              ? "retirement_unavailable"
              : "retirement_timeout",
        evidence,
        notice: `${id}（${a.machine_id}）空闲会话保留，凭据未撤销：${retirementReasons[evidence.reason]}（${facts}）。${nextStep}；若要停止，请主机操作员确认可中断工作后执行 cardigan assignment stop ${id} --project ${state.project_id}，核对退出结果；不自动重启。`,
      });
    }
    return next;
  });
}
