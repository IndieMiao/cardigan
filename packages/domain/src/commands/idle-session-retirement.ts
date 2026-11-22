import type { Actor, Assignment, RuntimeRef } from "../entities.js";
import type { AssignmentId, RunId } from "../ids.js";
import { retirementWaitReceipt } from "../retirement-session.js";
import {
  type RetirementDispatchWait,
  type RetirementSettlement,
  retirementObserveOnly,
  retirementReasons,
} from "../runtime-types.js";
import {
  darwinWorker,
  needsRetirementHandoff,
  retirementOwnsSession,
  sessionMaintenanceCandidate,
} from "../session-maintenance.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
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
        ...(prior?.dispatch_wait ? { dispatch_wait: prior.dispatch_wait } : {}),
        ...(prior?.notice_sent ? { notice_sent: true } : {}),
      },
    };
    d.put("assignments", next);
    if (
      !(
        next.idle_retirement?.observe_only &&
        prior?.evidence?.reason === "kept_terminal"
      )
    )
      d.emit(
        "idle_session_retirement_started",
        d.work(a.work_item_id!).card_id,
        {
          assignment_id: id,
        },
      );
    return next;
  });
}

function finishRetirement(d: CommandDraft, state: CommandState, a: Assignment) {
  // A resumption may enqueue during shutdown, but the fence prevents dispatch.
  // Preserve that queued Run and its original launch snapshot for the new session.
  ensure(
    !state.runs.some(
      (r) =>
        r.assignment_id === a.id &&
        !["queued", "completed", "failed", "cancelled"].includes(r.status),
    ),
    "illegal_transition",
    "Retiring Assignment has new work",
  );
  const { idle_retirement: _retirement, session_ref: _session, ...rest } = a;
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
  d.emit("session_replaced", d.work(a.work_item_id!).card_id, {
    assignment_id: a.id,
    reason: "idle_session_retired",
    ...retirementWaitReceipt(a),
    handoff: "空闲会话已回收；保留身份、工作区和分支，下次合法唤醒创建新会话。",
  });
  return next;
}

/** A queued Run prevents a new idle claim. Dispatch may present positive exit
 * evidence, but only for this exact waiting ref, never for an in-flight stop. */
export function confirmWaitingRetirementExit(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  observedRef: RuntimeRef,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may confirm retirement",
    );
    const a = d.get("assignments", id);
    ensure(
      a.idle_retirement?.phase === "waiting" &&
        !a.idle_retirement.handoff &&
        retirementOwnsSession(a) &&
        JSON.stringify(a.runtime_ref) === JSON.stringify(observedRef),
      "illegal_transition",
      "Waiting retirement changed",
    );
    return finishRetirement(d, state, a);
  });
}

/** A read-only dispatch probe must not change the stop fence, signal policy or retry budget. */
export function trackRetirementDispatch(
  state: CommandState,
  actor: Actor,
  expected: Assignment,
  runId: RunId,
  observation: RetirementDispatchWait | "woken",
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may report dispatch observations",
    );
    const a = d.get("assignments", expected.id),
      pending = a.idle_retirement;
    const run = d.get("runs", runId);
    if (
      a.scope !== "work_item" ||
      pending?.phase !== "waiting" ||
      pending.started_at !== expected.idle_retirement?.started_at ||
      !retirementOwnsSession(a) ||
      JSON.stringify(a.runtime_ref) !== JSON.stringify(expected.runtime_ref) ||
      run.assignment_id !== a.id
    )
      return;
    const card = d.work(a.work_item_id).card_id;
    const previous = pending.dispatch_wait;
    if (observation === "woken") {
      // Only a positive send receipt for the same incident can close a live wait.
      if (
        !previous ||
        previous.event_id !== expected.idle_retirement?.dispatch_wait?.event_id
      )
        return;
      const { dispatch_wait: _wait, ...rest } = pending;
      d.put("assignments", {
        ...a,
        idle_retirement: {
          ...rest,
          ...(rest.evidence
            ? { evidence: { ...rest.evidence, observation: "alive" as const } }
            : {}),
        },
      });
      d.emit("retirement_dispatch_resumed", card, {
        assignment_id: a.id,
        run_id: runId,
        ...retirementWaitReceipt(a),
      });
      return;
    }
    if (run.status !== "queued") return;
    if (run.queue_reason !== "runtime_unavailable")
      d.put("runs", { ...run, queue_reason: "runtime_unavailable" });
    const { source, status } = observation;
    if (previous?.source === source && previous.status === status) return;
    if (previous)
      d.emit("retirement_dispatch_wait_changed", card, {
        assignment_id: a.id,
        run_id: runId,
        evidence: observation,
        ...retirementWaitReceipt(a),
      });
    const stage = {
      owner: "原会话归属复查",
      snapshot: "会话状态读取",
      replacement: "等待确认旧会话退出后替换",
    }[source];
    const reason = status === "runtime_conflict" ? "归属冲突" : "续办仍在排队";
    const eventId =
      previous?.event_id ??
      d.emit("session_maintenance_attention", card, {
        assignment_id: a.id,
        run_id: runId,
        reason: "retirement_dispatch_wait",
        evidence: observation,
        notice: `${a.id}（${a.machine_id}）：${stage}：${reason}（${status}）。保留原会话、凭据及排队工作；请主机操作员用 hc get 只读核对终端地址、项目、指派和启动代次；未确认归属或退出前不停止、不替换。`,
      }).id;
    d.put("assignments", {
      ...a,
      idle_retirement: {
        ...pending,
        ...(pending.evidence
          ? {
              evidence: {
                ...pending.evidence,
                observation:
                  source === "owner"
                    ? status === "unsupported"
                      ? "unknown"
                      : status
                    : "alive",
              },
            }
          : {}),
        dispatch_wait: { ...observation, event_id: eventId },
      },
    });
  });
}

/** Adopt capped pre-upgrade records too, even when their Run is already queued.
 * Never clear the stop fence, change a retry into an exit or replace a wait receipt. */
export function handoffIdleSessionRetirement(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may hand off retirement",
    );
    const a = d.get("assignments", id);
    return needsRetirementHandoff(state, a) ? handoff(d, a) : a;
  });
}
function handoff(d: CommandDraft, a: Assignment) {
  const p = a.idle_retirement!;
  // A timeout from the old signal path also means a signal may have been sent.
  const phase = p.last_failure === "timeout" ? "stopping" : p.phase;
  const next: Assignment = {
    ...a,
    idle_retirement: { ...p, phase, handoff: true },
  };
  d.put("assignments", next);
  d.emit(
    "idle_session_retirement_handed_off",
    d.work(a.work_item_id!).card_id,
    {
      assignment_id: a.id,
      machine_id: a.machine_id,
      phase,
      failures: p.failures,
      reason: p.evidence?.reason ?? "confirmation_pending",
    },
  );
  return next;
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
    if (pending?.phase !== "stopping" || pending.handoff) return a;
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
      // A first claim explicitly withdrawn by the business guard never owned an
      // uncertain target. Do not drop an existing obligation (or an identity
      // failure) just because work arrived during the last probe.
      if (
        !retry &&
        pending.failures === 0 &&
        result.evidence.reason === "guard_changed"
      ) {
        const next: Assignment = identity;
        d.put("assignments", next);
        return next;
      }
    }
    if (result.outcome === "exited") return finishRetirement(d, state, a);
    const { evidence } = result;
    const outcome =
      result.outcome === "withdrawn" || result.outcome === "observing"
        ? "unavailable"
        : result.outcome;
    // A known kept shell is not a failure. Subsequent observations still
    // need ownership proof; three actual faults use the usual single notice.
    const kept =
      evidence.reason === "kept_terminal" &&
      (result.outcome === "withdrawn" || evidence.observation === "alive");
    const previouslyKept =
      pending.evidence?.reason === "kept_terminal" &&
      (!pending.evidence.observation ||
        pending.evidence.observation === "alive");
    const darwin = darwinWorker(state, a);
    const failures =
      !darwin && !kept && previouslyKept ? 1 : pending.failures + 1;
    const notify =
      !kept && failures >= 3 && !pending.notice_sent && !pending.dispatch_wait;
    const next: Assignment = {
      ...a,
      idle_retirement: {
        ...pending,
        phase:
          outcome === "uncertain" || (darwin && outcome === "timeout")
            ? "stopping"
            : "waiting",
        last_failure: outcome,
        evidence,
        failures,
        retry_at: new Date(Date.parse(d.now) + retryMs).toISOString(),
        ...(pending.notice_sent || (notify && !darwin)
          ? { notice_sent: true }
          : {}),
      },
    };
    if (needsRetirementHandoff(state, next)) return handoff(d, next);
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
      // The stop CLI cannot authenticate the owner of a legacy terminal address.
      // Even a previously verified address must be checked again by the operator.
      const verifiedLive =
        (evidence.observation === "alive" &&
          outcome === "unavailable" &&
          retirementObserveOnly(evidence)) ||
        (outcome === "timeout" &&
          evidence.reason === "still_live" &&
          evidence.terminal_state === "live");
      const verifyOwner =
        "请主机操作员用 hc get 只读核对终端地址、项目、指派和启动代次；无法确认归属时保留会话和凭据，不执行停止";
      const guidance = verifiedLive
        ? `${verifyOwner}。仅在归属吻合且确认可中断工作后执行 cardigan assignment stop ${id} --project ${state.project_id}，核对退出结果`
        : verifyOwner;
      d.emit("session_maintenance_attention", card, {
        assignment_id: id,
        reason:
          outcome === "uncertain"
            ? "retirement_pending"
            : outcome === "unavailable"
              ? "retirement_unavailable"
              : "retirement_timeout",
        evidence,
        notice: `${id}（${a.machine_id}）空闲会话保留，凭据未撤销：${retirementReasons[evidence.reason]}（${facts}）。${nextStep}；${guidance}；不自动重启。`,
      });
    }
    return next;
  });
}
