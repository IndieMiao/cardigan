import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import type { AssignmentId, CardId, RunId } from "../ids.js";
import {
  canonicalSessionFacts,
  retirementWaitReceipt,
} from "../retirement-session.js";
import { runsOf } from "../run-index.js";
import {
  type RetirementDispatchWait,
  type RetirementEvidence,
  type RetirementSettlement,
  retirementObserveOnly,
  retirementReasons,
} from "../runtime-types.js";
import {
  darwinWorker,
  needsRetirementHandoff,
  probeInvalidStreak,
  REFUSED_RETIREMENT_COOLDOWN_MS,
  retirementNoticeSent,
  retirementOwnsSession,
  retirementWithdrawals,
  sessionMaintenanceCandidate,
  sharedStallRegistration,
  supersededRetirement,
} from "../session-maintenance.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import {
  type RotationSignal,
  settleSessionRotation,
} from "./session-rotation.js";
import { humanStopRecorded, stoppedByHuman } from "./stop-state.js";
import { systemEndedTurn } from "./system-ended-turn.js";

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

function finishRetirement(
  d: CommandDraft,
  state: CommandState,
  a: Assignment,
  replaced: { reason: string; handoff: string } = {
    reason: "idle_session_retired",
    handoff: "空闲会话已回收；保留身份、工作区和分支，下次合法唤醒创建新会话。",
  },
) {
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
    reason: replaced.reason,
    ...(replaced.reason === "idle_session_retired"
      ? {}
      : { old_runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null }),
    ...retirementWaitReceipt(a),
    handoff: replaced.handoff,
  });
  return next;
}

/**
 * C-667/C-672: the host proved that the launched CLI of this exact ref is gone
 * while its terminal stayed live (the replacement shell of a kept terminal, or
 * a launcher that outlived the CLI), then closed that terminal. Settle the
 * session like a retirement: the Assignment, worktree, branch and any
 * untouched queued Run stay; the next legal wake starts a new session. A
 * pending retirement (waiting, handed off, or a stop whose exit was never
 * confirmed) is finished by this proof. A human stop, pending host operation,
 * role upgrade, Run stop or any started Run keeps the reference untouched.
 */
export function confirmKeptShellExit(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  releasedRef: RuntimeRef,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may settle an exited Agent session",
    );
    const a = d.get("assignments", id);
    ensure(
      a.scope === "work_item" &&
        !a.external &&
        a.status === "active" &&
        !a.role_upgrade &&
        !stoppedByHuman(state.events, a.id) &&
        !hostOpsPending(state.events, a.id) &&
        JSON.stringify(a.runtime_ref) === JSON.stringify(releasedRef),
      "illegal_transition",
      "Session changed while closing the exited Agent terminal",
    );
    ensure(
      !state.runs.some(
        (r) =>
          r.assignment_id === a.id && (r.dispatch_stop || r.inactivity_stop),
      ),
      "illegal_transition",
      "A Run stop is still in flight",
    );
    return finishRetirement(d, state, a, {
      reason: "agent_exited",
      handoff:
        "Agent 已退出，终端仍在；已关闭该终端，保留身份、工作区和分支，下次合法唤醒创建新会话。",
    });
  });
}

/** C-838: why an ended turn's session was idle when it was released. */
export type TurnDoneIdleBasis = "terminal_status" | "bound_idle_prompt";

/** C-730: what asked for a stale session to be released. */
export type UnresponsiveRelease =
  /** Session maintenance: this many `probe_invalid` withdrawals in a row. */
  | { readonly trigger: "probe_invalid"; readonly limit: number }
  /**
   * A host operator's restart or cancel of a remote managed Assignment, or
   * (C-759) a stop of a session whose last turn ended and that is idle.
   */
  | {
      readonly trigger: "host_ops";
      readonly requested_by: AssignmentId;
      readonly tool:
        | "host_ops_restart_assignment"
        | "host_ops_cancel_run"
        | "host_ops_stop_assignment";
      readonly reason: string;
      /** host_ops_cancel_run: also cancel this Run when it never started. */
      readonly run_id?: RunId;
    }
  /**
   * C-759: the last turn of this session ended, its CLI reports `done`, and
   * the never-started `queued_run_id` waited `waited_ms` without the session
   * being used (for example a resource machine that needs a fresh session),
   * while the checkout was clean. C-838: hc has no activity for Claude Code
   * or Codex (`unknown`); their bound empty editor with the CLI's own idle
   * footer is the equivalent evidence (`idle_basis=bound_idle_prompt`).
   */
  | {
      readonly trigger: "turn_done";
      readonly queued_run_id: RunId;
      readonly waited_ms: number;
      readonly workspace: "clean" | "no_worktree";
      /** Omitted: `terminal_status` (the CLI reported `done`). */
      readonly idle_basis?: TurnDoneIdleBasis;
    }
  /**
   * C-739: the system finished this Run, work is waiting for the Assignment,
   * and the old turn still could not be confirmed ended after `waited_ms`
   * while the checkout was clean.
   */
  | {
      readonly trigger: "system_turn";
      readonly system_finished_run_id: RunId;
      readonly waited_ms: number;
      readonly workspace: "clean" | "no_worktree";
    }
  /**
   * C-739: work waited `waited_ms` without a new Run while idle retirement of
   * this live session kept being given up (`withdrawals` times, at least 2),
   * and the checkout was clean.
   */
  | {
      readonly trigger: "retirement_withdrawn";
      readonly withdrawals: number;
      readonly waited_ms: number;
      readonly workspace: "clean" | "no_worktree";
    };

const unfinishedRun = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);

/**
 * C-759: a queued Run nothing has touched yet: never started, no bell sent,
 * no launch, dispatch or stop in flight. It holds no terminal, so cancelling
 * it or keeping it for a new session never affects a live session.
 */
export function untouchedQueuedRun(r: Run) {
  return (
    r.status === "queued" &&
    !r.started_at &&
    !r.finished_at &&
    !r.heartbeat_at &&
    !r.bell_delivery &&
    !r.recovery_runtime &&
    !r.launch_publication &&
    !r.pending_finish &&
    !r.dispatch_stop &&
    !r.inactivity_stop
  );
}

/**
 * C-759: the session's previous turn ended: no Run on it is unfinished except
 * untouched queued ones, and the session was not launched for one of those
 * (that launch may still be starting).
 */
export function sessionTurnEnded(state: CommandState, a: Assignment) {
  const runs = runsOf(state.runs, a.id);
  const launch = a.runtime_ref?.launch_generation?.run_id;
  return runs.every(
    (r) =>
      !unfinishedRun(r.status) || (untouchedQueuedRun(r) && r.id !== launch),
  );
}

/**
 * C-730: why this session may not be released as unresponsive now
 * (undefined: it may). The host additionally proves that the Agent CLI is not
 * observed alive before, and that the session exited after, it closes the
 * terminal. A human stop, a pending host operation, a role upgrade, a Run
 * stop or launch in flight, or another registration on the same terminal or
 * worktree always keeps the session. The maintenance trigger also needs a
 * session between Runs and the `probe_invalid` streak.
 */
export function unresponsiveReleaseBlocker(
  state: CommandState,
  a: Assignment,
  p: UnresponsiveRelease,
):
  | "not_managed"
  | "no_session"
  | "stopped_by_human"
  | "operation_pending"
  | "upgrade_pending"
  | "shared_registration"
  | "run_busy"
  | "run_changed"
  | "probe_streak"
  | "session_maintenance"
  | "withdrawal_streak"
  | undefined {
  if (a.scope !== "work_item" || a.external || a.status !== "active")
    return "not_managed";
  if (!a.runtime_ref) return "no_session";
  if (stoppedByHuman(state.events, a.id)) return "stopped_by_human";
  if (a.role_upgrade) return "upgrade_pending";
  const runs = runsOf(state.runs, a.id);
  if (
    hostOpsPending(state.events, a.id) ||
    runs.some(
      (r) =>
        r.dispatch_stop ||
        r.inactivity_stop ||
        (r.launch_publication &&
          !["started", "exited"].includes(r.launch_publication.phase)),
    )
  )
    return "operation_pending";
  if (sharedStallRegistration(state, a)) return "shared_registration";
  if (p.trigger === "host_ops") {
    if (
      p.run_id !== undefined &&
      !runs.some((r) => r.id === p.run_id && unfinishedRun(r.status))
    )
      return "run_changed";
    // C-759: a stop only ends a session whose previous turn already ended.
    if (p.tool === "host_ops_stop_assignment" && !sessionTurnEnded(state, a))
      return "run_busy";
    return undefined;
  }
  if (runs.some((r) => r.status !== "queued" && unfinishedRun(r.status)))
    return "run_busy";
  if (p.trigger === "turn_done") {
    if (!sessionTurnEnded(state, a)) return "run_busy";
    if (a.idle_retirement && a.idle_retirement.phase !== "waiting")
      return "session_maintenance";
    // A system-ended turn has its own trigger and recovery.
    if (systemEndedTurn(state, a)) return "run_changed";
    return runs.some((r) => r.id === p.queued_run_id && untouchedQueuedRun(r))
      ? undefined
      : "run_changed";
  }
  if (p.trigger === "system_turn") {
    // An idle retirement owns its session; the release would race it.
    if (a.idle_retirement) return "session_maintenance";
    return systemEndedTurn(state, a)?.id === p.system_finished_run_id
      ? undefined
      : "run_changed";
  }
  if (p.trigger === "retirement_withdrawn") {
    // Only a retirement that signals nothing (waiting) may be dropped here.
    if (a.idle_retirement && a.idle_retirement.phase !== "waiting")
      return "session_maintenance";
    return retirementWithdrawals(state, a) >= p.withdrawals
      ? undefined
      : "withdrawal_streak";
  }
  return probeInvalidStreak(state, a) >= p.limit ? undefined : "probe_streak";
}

/**
 * C-730: the host closed the terminal of this exact session after the Agent
 * CLI was not observed alive, and proved the session exited. Settle it like a
 * managed `cardigan assignment stop`: Runs that had started on it are
 * cancelled, never-started queued Runs stay as pending work (except the Run a
 * host operator asked to cancel), the ref, session and any idle retirement
 * are cleared, and the next legal wake starts a new session. Identity,
 * worktree and branch stay. Recorded on the card timeline.
 */
export function releaseUnresponsiveSession(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  releasedRef: RuntimeRef,
  p: UnresponsiveRelease,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may release an unresponsive session",
    );
    if (p.trigger === "probe_invalid")
      ensure(
        Number.isSafeInteger(p.limit) && p.limit >= 1 && p.limit <= 100,
        "validation_failed",
        "Invalid probe limit",
      );
    else if (
      p.trigger === "system_turn" ||
      p.trigger === "retirement_withdrawn" ||
      p.trigger === "turn_done"
    )
      ensure(
        Number.isSafeInteger(p.waited_ms) &&
          p.waited_ms >= 0 &&
          ["clean", "no_worktree"].includes(p.workspace) &&
          (p.trigger === "system_turn" ||
            (p.trigger === "turn_done" &&
              /^R-[1-9][0-9]*$/u.test(p.queued_run_id) &&
              [undefined, "terminal_status", "bound_idle_prompt"].includes(
                p.idle_basis,
              )) ||
            (p.trigger === "retirement_withdrawn" &&
              Number.isSafeInteger(p.withdrawals) &&
              p.withdrawals >= 2 &&
              p.withdrawals <= 1000)),
        "validation_failed",
        "Invalid stalled session release",
      );
    else text(p.reason, "reason");
    const a = d.get("assignments", id);
    ensure(
      JSON.stringify(canonicalSessionFacts(a.runtime_ref)) ===
        JSON.stringify(canonicalSessionFacts(releasedRef)),
      "illegal_transition",
      "Session changed while closing its terminal",
    );
    const blocker = unresponsiveReleaseBlocker(state, a, p);
    ensure(
      !blocker,
      "illegal_transition",
      `Session cannot be released: ${blocker}`,
    );
    const card = d.work(a.work_item_id!).card_id;
    const summary =
      p.trigger === "host_ops"
        ? `released by host operations (${p.requested_by})`
        : p.trigger === "system_turn"
          ? `released after the system-ended turn of ${p.system_finished_run_id} stayed unconfirmed`
          : p.trigger === "retirement_withdrawn"
            ? "released after work waited while idle retirement kept withdrawing"
            : p.trigger === "turn_done"
              ? `released after ${p.queued_run_id} waited on an idle session`
              : "released after the Agent stopped responding";
    const cancelled = d
      .list("runs")
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          unfinishedRun(r.status) &&
          !(
            r.status === "queued" &&
            !r.started_at &&
            !(p.trigger === "host_ops" && r.id === p.run_id)
          ),
      );
    for (const r of cancelled)
      d.put("runs", {
        ...r,
        status: unwrap(transition("run", r.status, "cancel")),
        outcome: "failed",
        summary,
        finished_at: d.now,
      });
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
    const streak = probeInvalidStreak(state, a);
    const runsNote = cancelled.length
      ? `，已取消在该会话上的 ${cancelled.map((r) => r.id).join("、")}`
      : "";
    const handoff =
      p.trigger === "turn_done"
        ? `${a.id}（${a.machine_id}）上一轮已结束、会话空闲（${p.idle_basis === "bound_idle_prompt" ? "停在空输入框" : "done"}），排队的 ${p.queued_run_id} ${Math.round(p.waited_ms / 60_000)} 分钟仍未开始，${p.workspace === "clean" ? "工作区干净" : "没有工作区"}。系统已受管释放旧会话并确认退出${runsNote}；保留身份、工作区和分支，排队的工作在新会话中派发。`
        : p.trigger === "host_ops" && p.tool === "host_ops_stop_assignment"
          ? `主机运维 ${p.requested_by} 请求停止空闲会话：${a.id}（${a.machine_id}）上一轮已结束、会话空闲，已关闭终端并确认会话退出${runsNote}；保留身份、工作区和分支，排队的工作在新会话中派发。`
          : p.trigger === "retirement_withdrawn"
            ? `${a.id}（${a.machine_id}）有待办 ${Math.round(p.waited_ms / 60_000)} 分钟仍派不出新 Run，空闲回收已 ${p.withdrawals} 次被撤回，${p.workspace === "clean" ? "工作区干净" : "没有工作区"}。系统已受管释放旧会话并确认退出${runsNote}；保留身份、工作区和分支，待办在新会话中派发。`
            : p.trigger === "system_turn"
              ? `系统代为结束 ${p.system_finished_run_id} 后，${a.id}（${a.machine_id}）的旧回合 ${Math.round(p.waited_ms / 60_000)} 分钟仍确认不了是否结束，${p.workspace === "clean" ? "工作区干净" : "没有工作区"}。系统已受管释放旧会话并确认退出${runsNote}；保留身份、工作区和分支，排队的工作在新会话中派发。`
              : p.trigger === "host_ops"
                ? `主机运维 ${p.requested_by} 请求${p.tool === "host_ops_cancel_run" ? "取消 Run" : "重启"}：${a.id}（${a.machine_id}）的 Agent 进程未见存活，已关闭残留终端并确认会话退出${runsNote}；保留身份、工作区和分支，有待办时按受管入口新起会话。`
                : `${a.id}（${a.machine_id}）的 Agent 进程已不在、终端仍残留：空闲回收连续 ${streak} 次未取得有效进程身份。系统已关闭该终端并确认会话退出${runsNote}；保留身份、工作区和分支，有待办时按受管入口新起会话。`;
    const replaced = d.emit(
      "session_replaced",
      card,
      {
        assignment_id: a.id,
        reason:
          p.trigger === "system_turn"
            ? "system_turn_unconfirmed"
            : p.trigger === "retirement_withdrawn"
              ? "retirement_withdrawn"
              : p.trigger === "turn_done" ||
                  (p.trigger === "host_ops" &&
                    p.tool === "host_ops_stop_assignment")
                ? "idle_session_stopped"
                : "agent_unresponsive",
        trigger: p.trigger,
        ...(p.trigger === "system_turn"
          ? {
              system_finished_run_id: p.system_finished_run_id,
              waited_ms: p.waited_ms,
              workspace: p.workspace,
            }
          : {}),
        ...(p.trigger === "turn_done"
          ? {
              queued_run_id: p.queued_run_id,
              waited_ms: p.waited_ms,
              workspace: p.workspace,
              idle_basis: p.idle_basis ?? "terminal_status",
            }
          : {}),
        ...(p.trigger === "retirement_withdrawn"
          ? {
              withdrawals: p.withdrawals,
              waited_ms: p.waited_ms,
              workspace: p.workspace,
            }
          : {}),
        ...(p.trigger === "host_ops"
          ? {
              requested_by: p.requested_by,
              tool: p.tool,
              ...(p.run_id ? { run_id: p.run_id } : {}),
            }
          : {}),
        probe_invalid: streak,
        cancelled_run_ids: cancelled.map((r) => r.id),
        old_runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
        ...retirementWaitReceipt(a),
        handoff,
      },
      { type: "handoff", body: handoff },
    );
    // C-789: the host proved this exact session exited. Work that was in
    // flight on it is rerun once per Assignment under the shared rotation rule;
    // a host operator's own restart or cancel stays theirs.
    const signal = rotationSignal(p);
    if (cancelled.length && signal)
      settleSessionRotation(
        d,
        next,
        signal,
        cancelled.find((r) => r.status !== "queued"),
        { runtime_ref: releasedRef, exited: true, evidence: replaced.id },
      );
    return next;
  });
}

/** C-789: which stuck-session signal a proven release settles, if any. */
function rotationSignal(p: UnresponsiveRelease): RotationSignal | undefined {
  switch (p.trigger) {
    case "turn_done":
      return "idle_scarce";
    case "system_turn":
      return "bell_deferred";
    case "retirement_withdrawn":
    case "probe_invalid":
      return "retirement_failed";
    case "host_ops":
      return p.tool === "host_ops_stop_assignment" ? "idle_scarce" : undefined;
  }
}

/**
 * C-690: drop a waiting retirement left behind by a session this Assignment no
 * longer runs (see `supersededRetirement`): the human started a new session
 * after a stop released the old one. Nothing was signalled and its ref is not
 * the current binding, so it owns neither an exit nor a credential decision.
 * The current session, worktree, branch and queued Runs are kept; a stopping
 * retirement (a signal may be in flight) is never dropped here.
 */
export function clearSupersededRetirement(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may clear a superseded retirement",
    );
    const a = d.get("assignments", id);
    if (a.scope !== "work_item" || !supersededRetirement(a)) return a;
    return dropWaitingRetirement(d, a, "superseded");
  });
}

/**
 * C-690: an idle retirement that gave up on this session (handed off, still
 * `waiting`: nothing was signalled) retained it for dispatch. When new work
 * arrives for it as notifications only, no host operation consumes that
 * handoff (C-575 takes over queued successors), so it fenced the live session
 * indefinitely. Withdraw it so the dispatcher wakes the session through its
 * ordinary guarded path. A started or running Run, a Run stop, a human stop,
 * a pending host operation or a role upgrade keeps the handoff.
 *
 * C-739: a queued Run that never started is waiting work like a
 * notification. A remote worker never gives C-575 the exit proof it needs,
 * so that handoff fenced the queued Run until someone stopped the session
 * (sensen A-317).
 */
export function releaseRetainedRetirement(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may release a retained retirement",
    );
    const a = d.get("assignments", id);
    ensure(
      a.scope === "work_item" &&
        !a.external &&
        a.status === "active" &&
        a.idle_retirement?.phase === "waiting" &&
        a.idle_retirement.handoff === true &&
        retirementOwnsSession(a) &&
        !a.role_upgrade &&
        !stoppedByHuman(state.events, a.id) &&
        !hostOpsPending(state.events, a.id) &&
        !state.runs.some(
          (r) =>
            r.assignment_id === a.id &&
            ((!["completed", "failed", "cancelled"].includes(r.status) &&
              !(r.status === "queued" && !r.started_at)) ||
              r.dispatch_stop ||
              r.inactivity_stop),
        ),
      "illegal_transition",
      "Retained retirement changed",
    );
    return dropWaitingRetirement(d, a, "business_work");
  });
}

/** Shared by the cleanups above and a new session's dispatch. */
export function dropWaitingRetirement(
  d: CommandDraft,
  a: Assignment,
  reason: "superseded" | "business_work",
): Assignment {
  const { idle_retirement: p, ...identity } = a;
  if (!p || p.phase !== "waiting") return a;
  const rest: Assignment = identity;
  d.put("assignments", rest);
  d.emit(
    reason === "superseded"
      ? "idle_session_retirement_superseded"
      : "idle_session_retirement_released",
    d.work(a.work_item_id!).card_id,
    {
      assignment_id: a.id,
      machine_id: a.machine_id,
      reason,
      handoff: p.handoff === true,
      failures: p.failures,
      started_at: p.started_at,
    },
  );
  return rest;
}

/**
 * C-752 (sensen A-388): a human stop released the exact session an idle
 * retirement was claimed for, and the host proved that terminal gone. Like
 * `confirmKeptShellExit`, that proof finishes the retirement in either phase
 * (a handed-off `stopping` one never settles itself). Without it the record,
 * no longer bound to any session, fences every later bell until a human start.
 */
export function dropReleasedRetirement(
  d: CommandDraft,
  a: Assignment,
  card: CardId,
): Assignment {
  const { idle_retirement: p, ...identity } = a;
  if (!p || !retirementOwnsSession(a)) return a;
  if (p.phase === "waiting") return dropWaitingRetirement(d, a, "superseded");
  const rest: Assignment = identity;
  d.put("assignments", rest);
  d.emit("idle_session_retirement_superseded", card, {
    assignment_id: a.id,
    machine_id: a.machine_id,
    reason: "session_released",
    phase: p.phase,
    handoff: p.handoff === true,
    failures: p.failures,
    started_at: p.started_at,
  });
  return rest;
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
      // C-746: binds the handoff to its session (refused-retirement cooldown).
      runtime_ref: { ...p.runtime_ref },
      ...(p.evidence?.owner_reason
        ? { owner_reason: p.evidence.owner_reason }
        : {}),
      // C-804: which idle-owner precondition failed, and the launch's enrollment.
      ...(p.evidence?.precondition
        ? { precondition: p.evidence.precondition }
        : {}),
      ...(p.evidence?.enrollment ? { enrollment: p.evidence.enrollment } : {}),
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
        (a.runtime_ref === null && humanStopRecorded(state.events, a.id)),
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
        // C-730: binds the withdrawal to its session (probeInvalidStreak).
        runtime_ref: { ...pending.runtime_ref },
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
    if (needsRetirementHandoff(state, next)) {
      const handed = handoff(d, next);
      // C-746: a macOS session that refused three attempts is retained, not
      // retired. Say so once per idle session, with the cause and the commands
      // to resolve it; repeated hand-backs of the same session add no notice.
      if (
        failures >= 3 &&
        !kept &&
        !pending.dispatch_wait &&
        !retirementNoticeSent(state, a)
      )
        emitRetirementNotice(d, state, a, card, outcome, evidence, true);
      return handed;
    }
    d.put("assignments", next);
    if (notify) emitRetirementNotice(d, state, a, card, outcome, evidence);
    return next;
  });
}

/** Bounded facts of a retirement attempt for a notice; never paths or text. */
function retirementFacts(evidence: RetirementEvidence) {
  return [
    evidence.stage,
    evidence.terminal_state,
    evidence.hc_kind,
    evidence.runtime_code,
    evidence.owner_reason,
    evidence.precondition,
    evidence.enrollment === undefined
      ? undefined
      : `enrollment=${evidence.enrollment}`,
    evidence.exit_code === undefined ? undefined : `exit=${evidence.exit_code}`,
    evidence.observation,
  ]
    .filter((v) => v !== undefined)
    .join(" / ");
}

/**
 * C-746: what an operator can run for a macOS session that keeps refusing
 * retirement. Each step is read-only until the explicit managed stop, which
 * keeps the worktree and branch.
 */
function refusedRetirementGuidance(
  state: CommandState,
  a: Assignment,
  evidence: RetirementEvidence,
) {
  const stop = `cardigan assignment stop ${a.id} --project ${state.project_id}`;
  const terminal = a.runtime_ref?.terminal_ref;
  const inspect = `主机运维可用 host_ops_inspect_worker（machine_id=${a.machine_id}，assignment_id=${a.id}，不带 run_id）只读查看终端、进程和失败原因`;
  if (evidence.reason === "workspace_not_clean")
    return `${inspect}；在 ${a.machine_id} 上以项目账号执行 git -C ${a.worktree_path ?? "<工作区>"} status --short 核对改动。确认这些改动可以留在原工作区后执行 ${stop} 释放会话（工作区和分支保留），否则先由负责人提交或清理`;
  if (evidence.owner_reason === "legacy_owner_refused")
    return `${inspect}；该会话的空闲 owner 在 C-746 之前启动，按旧规则看不到状态栏上方的空输入框；按当前规则核对已通过。确认可以中断后执行 ${stop} 释放会话，下次唤醒的新会话使用新规则`;
  if (evidence.reason === "terminal_busy")
    return `${inspect}；终端仍显示在工作或等待确认，在控制端用 hc get ${terminal} 只读核对。确认可以中断后执行 ${stop}`;
  return `${inspect}；在控制端用 hc get ${terminal} 只读核对终端仍在 herdr-core 登记且归属吻合（项目、指派、启动代次）。归属吻合且可以中断时执行 ${stop}，核对退出结果；无法确认归属时保留会话和凭据`;
}

function emitRetirementNotice(
  d: CommandDraft,
  state: CommandState,
  a: Assignment,
  card: CardId,
  outcome: "uncertain" | "unavailable" | "timeout",
  evidence: RetirementEvidence,
  darwinHandoff = false,
) {
  const id = a.id;
  const facts = retirementFacts(evidence);
  let tail: string;
  if (darwinHandoff) {
    tail = `已保留会话待投递，同一会话 ${REFUSED_RETIREMENT_COOLDOWN_MS / 3_600_000} 小时内不再自动回收，有活动前不再重复通知。${refusedRetirementGuidance(state, a, evidence)}`;
  } else {
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
    tail = `${nextStep}；${guidance}`;
  }
  d.emit("session_maintenance_attention", card, {
    assignment_id: id,
    reason:
      outcome === "uncertain"
        ? "retirement_pending"
        : outcome === "unavailable"
          ? "retirement_unavailable"
          : "retirement_timeout",
    evidence,
    // C-746: binds the notice to its session (retirementNoticeSent).
    ...(a.runtime_ref ? { runtime_ref: { ...a.runtime_ref } } : {}),
    notice: `${id}（${a.machine_id}）空闲会话保留，凭据未撤销：${retirementReasons[evidence.reason]}（${facts}）。${tail}；不自动重启。`,
  });
}
