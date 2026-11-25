import { heldStandingRun, standingRunDormant } from "../card-hold.js";
import {
  contextRestartRecovery,
  humanRestartCommand,
} from "../context-restart-retry.js";
import type { Actor, Assignment, RuntimeRef } from "../entities.js";
import type { Result } from "../errors.js";
import {
  hostOpsActionPending,
  hostOpsPending,
  openRestartFailures,
} from "../host-ops.js";
import type { AssignmentId, HumanActionId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { handoffWithoutOps } from "./ops-handoff.js";

function standing(d: CommandDraft, id: AssignmentId) {
  ensure(
    d.actor.kind === "human" ||
      (d.actor.kind === "system" &&
        ["manage_host_ops_action", "recover_standing_pm"].includes(d.tool)),
    "unauthorized",
    "Only the human or the host_ops action flow can pause or resume a standing PM",
  );
  const a = d.get("assignments", id);
  ensure(
    d.tool === "manage_host_ops_action" || !hostOpsPending(d.state.events, id),
    "illegal_transition",
    "A host operation is pending",
  );
  ensure(
    a.scope === "standing" && a.role_id === "pm",
    "unauthorized",
    "Only standing PM assignments can be paused here",
  );
  return a;
}
/** Host command: persist the spending boundary before touching the external runtime. */
export function pauseStandingAssignment(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId },
  ports: CommandPorts,
): Result<CommandEffect<{ assignment: Assignment; aborted: boolean }>> {
  return command(state, actor, "pause_standing_assignment", ports, (d) => {
    return pauseStandingInDraft(d, p.assignment_id);
  });
}
export function pauseStandingInDraft(
  d: CommandDraft,
  id: AssignmentId,
): { assignment: Assignment; aborted: boolean } {
  const a = standing(d, id);
  if (a.status === "suspended") {
    handoffWithoutOps(d, a);
    return { assignment: a, aborted: false };
  }
  const status = unwrap(transition("assignment", a.status, "suspend"));
  const runs = d
    .list("runs")
    .filter(
      (r) =>
        r.assignment_id === a.id &&
        !["completed", "failed", "cancelled"].includes(r.status),
    );
  for (const r of runs)
    d.put("runs", {
      ...r,
      status: unwrap(transition("run", r.status, "cancel")),
      outcome: "failed",
      summary:
        d.actor.kind === "human"
          ? "Standing PM paused by human"
          : "Standing PM paused by host_ops",
      finished_at: d.now,
    });
  const next = {
    ...a,
    status,
    runtime_state:
      a.runtime_state === "running"
        ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
        : a.runtime_state,
  };
  d.put("assignments", next);
  d.emit("assignment_paused", undefined, {
    assignment_id: a.id,
    cancelled_run_ids: runs.map((r) => r.id),
  });
  handoffWithoutOps(d, next);
  return { assignment: next, aborted: runs.length > 0 };
}
/**
 * C-154: give an active standing PM a fresh session on the same Assignment.
 * Unlike a pause, nothing is suspended and no decision or human action leaves
 * the PM: the Assignment that owns them stays on duty throughout. Called
 * inside queueRun so the restart and the new Run are one transaction.
 */
export function restartStandingSession(
  d: CommandDraft,
  id: AssignmentId,
  expected_runtime_ref?: RuntimeRef | null,
  reuse_queued = false,
) {
  const a = restartable(d, id);
  const label = a.role_id === "host_ops" ? "常驻主机运维" : "常驻 PM ";
  ensure(
    a.status === "active",
    "illegal_transition",
    a.role_id === "host_ops"
      ? "只有在岗的常驻主机运维能重开会话"
      : "只有在岗的常驻 PM 能重开会话；已暂停的请用 cardigan pm start 恢复",
  );
  // The caller proved this exact session exited; any other session (started
  // by a concurrent restart or the Dispatcher) must not be dropped unseen.
  ensure(
    expected_runtime_ref === undefined ||
      JSON.stringify(a.runtime_ref) === JSON.stringify(expected_runtime_ref),
    "stale_target",
    `${label}的会话已变化，没有替换；请重新运行`,
  );
  // Only this restart's own effect is checked below: the host_ops settlement
  // may already have closed its exit confirmation (C-152) in the same draft.
  const owned = () =>
    JSON.stringify([d.list("decisions"), d.list("human_actions")]);
  const before = owned();
  const runs = d
    .list("runs")
    .filter(
      (r) =>
        r.assignment_id === a.id &&
        !(reuse_queued
          ? standingRunDormant(a, r)
          : heldStandingRun(a, r, d.state)) &&
        !["completed", "failed", "cancelled"].includes(r.status),
    );
  for (const r of runs)
    d.put("runs", {
      ...r,
      status: unwrap(transition("run", r.status, "cancel")),
      outcome: "failed",
      summary:
        d.actor.kind === "human"
          ? `Standing ${a.role_id === "host_ops" ? "host_ops" : "PM"} session restarted by human`
          : `Standing ${a.role_id === "host_ops" ? "host_ops" : "PM"} session restarted by host_ops`,
      finished_at: d.now,
    });
  const { session_ref: _oldSession, ...rest } = a;
  const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
    ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
    : a.runtime_state === "running"
      ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
      : a.runtime_state;
  d.put("assignments", { ...rest, runtime_state, runtime_ref: null });
  d.emit("standing_session_restarted", undefined, {
    assignment_id: a.id,
    old_runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
    cancelled_run_ids: runs.map((r) => r.id),
    handoff: `${label}会话由${d.actor.kind === "human" ? "人" : "主机运维"}重开，Assignment 不变，待处理事项仍归你。读取排队门铃对应的 get_updates，再 ack_events。`,
  });
  ensure(
    owned() === before,
    "invariant_violation",
    `重开${label}会话不能转交拍板或待你执行`,
  );
  // C-741: the human's restart is the recovery a failed automatic restart
  // asked for; its old session is now replaced, so close those items.
  if (d.actor.kind === "human") settleRestartFailures(d, a);
}

/**
 * C-741: who may restart a standing session in place. The human may restart
 * a standing PM or the standing host operator; the system only within a host
 * operation. A failed automatic restart's fence does not stop the human: this
 * restart clears it in the same transaction.
 */
function restartable(d: CommandDraft, id: AssignmentId) {
  const a = d.get("assignments", id);
  if (a.scope === "standing" && a.role_id === "pm") {
    if (d.actor.kind !== "human") return standing(d, id);
  } else
    ensure(
      d.actor.kind === "human" &&
        a.scope === "standing" &&
        a.role_id === "host_ops",
      "unauthorized",
      "Only standing PM or host_ops sessions can be restarted here",
    );
  ensure(
    d.actor.kind === "human",
    "unauthorized",
    "Only the human or the host_ops action flow can restart a standing session",
  );
  ensure(
    !hostOpsActionPending(d.state.events, id),
    "illegal_transition",
    "A host operation is pending",
  );
  return a;
}

/**
 * Complete, as the human who just restarted it, every open recovery item.
 * These system items block no work item, so this is the plain completion
 * transition and audit of `completeActionDraft` (which cannot be imported
 * here without a module cycle through launch).
 */
function settleRestartFailures(d: CommandDraft, a: Assignment) {
  for (const failure of openRestartFailures(d.state.events)) {
    const p = failure.payload as {
      assignment_id?: string;
      human_action_id?: HumanActionId;
    };
    if (p.assignment_id !== a.id || !p.human_action_id) continue;
    const recovery = contextRestartRecovery(d.state.events, p.human_action_id);
    const item = d
      .list("human_actions")
      .find((h) => h.id === p.human_action_id);
    if (!recovery || item?.status !== "open" || item.blocked_work_items.length)
      continue;
    const text = `人已执行 ${humanRestartCommand(a, d.state.project_id) ?? "重开会话命令"}，旧会话已确认退出并替换。`;
    d.put("human_actions", {
      ...item,
      status: unwrap(transition("human_action", item.status, "complete")),
      result: { text, attachments: [], at: d.now },
    });
    d.emit(
      "human_action_completed",
      item.card_id,
      { human_action_id: item.id, resume_work_items: [] },
      { type: "human_action", body: text, human_action_id: item.id },
    );
  }
}
/** Called inside queueRun so resuming and reserving the new Run are atomic. */
export function resumeStanding(d: CommandDraft, id: AssignmentId): void {
  const a = standing(d, id);
  const status = unwrap(transition("assignment", a.status, "resume"));
  const { session_ref: _oldSession, ...rest } = a;
  const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
    ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
    : a.runtime_state;
  d.put("assignments", { ...rest, status, runtime_state, runtime_ref: null });
  d.emit("assignment_resumed", undefined, {
    assignment_id: a.id,
    old_runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
    handoff: `常驻 PM 由${d.actor.kind === "human" ? "人" : "主机运维"}恢复。读取排队门铃对应的 get_updates，再 ack_events；配置与会话历史保留在原 Assignment 运行目录。`,
  });
}
