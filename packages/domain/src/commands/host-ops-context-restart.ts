import {
  type ContextObservation,
  contextNoticeRecorded,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
} from "../context-usage.js";
import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
import { eventById, eventsOfType } from "../event-index.js";
import {
  type HostOpsExecution,
  hostOpsPending,
  pendingHostOpsActions,
} from "../host-ops.js";
import type { EventId } from "../ids.js";
import { runsOf } from "../run-index.js";
import type { RetirementIdentity } from "../runtime-port.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";
import {
  beginHostOpsActionInDraft,
  retirementStallHandoff,
} from "./host-ops-actions.js";
import { queueRunInDraft, settingsValid } from "./launch.js";
import { projectPreferences } from "./preferences.js";
import { stoppedByHuman } from "./stop-state.js";
import { systemEndedTurn } from "./system-ended-turn.js";

export { systemEndedTurn };

/** Reused before preparation, in the intent transaction and immediately before stopping. */
export function automaticContextRestartReady(
  state: CommandState,
  usage: ContextObservation,
  now: string,
  staleAfterMs: number,
  actionId?: HostOpsExecution["action_id"],
) {
  const a = state.assignments.find((a) => a.id === usage.assignment_id);
  if (
    a?.scope !== "standing" ||
    a.role_id !== "host_ops" ||
    a.external ||
    a.machine_id !== "local" ||
    !a.runtime_ref ||
    stoppedByHuman(state.events, a.id) ||
    !contextObservationCurrent(a, usage, state.events) ||
    !contextUsageFresh(usage, now, staleAfterMs) ||
    contextUsageLevel(usage, projectPreferences(state)) !== "restart" ||
    !contextNoticeRecorded(state.events, usage, "restart")
  )
    return false;
  if (
    state.runs.some(
      (r) =>
        r.assignment_id === a.id &&
        (!["completed", "failed", "cancelled"].includes(r.status) ||
          r.dispatch_stop ||
          r.inactivity_stop),
    )
  )
    return false;
  if (
    pendingHostOpsActions(state.events).some(
      (action) =>
        action.action_id !== actionId &&
        (action.assignment_id === a.id ||
          state.events.some(
            (e) =>
              e.id === action.action_id &&
              e.actor.kind === "assignment" &&
              e.actor.assignment_id === a.id,
          )),
    )
  )
    return false;
  return (
    actionId !== undefined ||
    (!hostOpsPending(state.events, a.id) &&
      !eventsOfType(state.events, "host_ops_action_taken").some(
        (e) =>
          (e.payload as { assignment_id?: string }).assignment_id === a.id &&
          (e.payload as { context_usage?: ContextObservation }).context_usage
            ?.session_id === usage.session_id,
      ))
  );
}

export function beginAutomaticContextRestart(
  state: CommandState,
  actor: Actor,
  p: {
    usage: ContextObservation;
    stale_after_ms: number;
    snapshot?: HostOpsExecution["snapshot"];
    preparation_failed?: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    if (!automaticContextRestartReady(state, p.usage, d.now, p.stale_after_ms))
      return;
    if (!p.preparation_failed) {
      ensure(p.snapshot, "validation_failed", "Launch snapshot is required");
      text(p.snapshot.model, "model");
      text(p.snapshot.agent_cli_version, "agent_cli_version");
      settingsValid(p.snapshot);
      if (p.snapshot.launch_profile_ref !== undefined)
        text(p.snapshot.launch_profile_ref, "launch_profile_ref");
    }
    const intent = beginHostOpsActionInDraft(d, {
      tool: "host_ops_restart_assignment",
      target_id: p.usage.assignment_id,
      reason: "主机运维自身上下文到档，系统在空闲时换会话。",
      automatic_context_restart: true,
      context_usage: p.usage,
      context_stale_after_ms: p.stale_after_ms,
      ...(p.snapshot ? { snapshot: p.snapshot } : {}),
    });
    if (p.preparation_failed)
      recordResult(d, intent.action_id, "failed", "启动配置准备失败");
    return intent;
  });
}

/** Flow 5 loopback launches have no generation. The creating Run's label
 * stays on the terminal across reused bells. Use the first confirmed dispatch
 * on the exact bound ref, never the most recent Run or the address alone. */
export function systemTurnOwner(
  state: CommandState,
  assignment: Assignment["id"],
  ref: RuntimeRef | null,
  endedRun: string,
): RetirementIdentity {
  const identity = { project_id: state.project_id, assignment_id: assignment };
  if (
    ref?.target?.generation !== "legacy" ||
    ref.machine_id !== "local" ||
    ref.runtime_machine === "local" ||
    ref.launch_generation
  )
    return identity;
  const key = JSON.stringify(ref);
  let first: Run["bell_delivery"],
    ambiguous = false,
    endedBound = false;
  for (const r of runsOf(state.runs, assignment)) {
    const bell = r.bell_delivery;
    if (!bell || JSON.stringify(bell.runtime_ref) !== key) continue;
    if (bell.run_id !== r.id || !bell.sent_at) return identity;
    if (r.id === endedRun) endedBound = true;
    if (!first?.sent_at || bell.sent_at < first.sent_at) {
      first = bell;
      ambiguous = false;
    } else if (bell.sent_at === first.sent_at) ambiguous = true;
  }
  return endedBound && first && !ambiguous
    ? { ...identity, first_bell_run_id: first.run_id }
    : identity;
}

/** An expired dispatch guard, not general authority for system to restart a worker. */
export function beginSystemTurnRestart(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: Assignment["id"];
    cause_id: string;
    review_trigger_id?: EventId;
    snapshot: NonNullable<HostOpsExecution["snapshot"]>;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const a = d.get("assignments", p.assignment_id);
    const due = eventById(state.events, p.cause_id);
    const turn = systemEndedTurn(state, a);
    const payload = due?.payload as
      | { run_id?: string; assignment_id?: string }
      | undefined;
    const handoff = retirementStallHandoff(state, a, p.cause_id);
    ensure(
      handoff ||
        (turn &&
          a.runtime_ref &&
          due?.actor.kind === "system" &&
          due.type === "bell_turn_recovery_due" &&
          payload?.run_id === turn.id &&
          payload.assignment_id === a.id),
      "illegal_transition",
      "门铃恢复原因或原会话已改变",
    );
    ensure(
      !pendingHostOpsActions(state.events).some((action) => {
        const origin = eventById(state.events, action.action_id)?.actor;
        return origin?.kind === "assignment" && origin.assignment_id === a.id;
      }),
      "illegal_transition",
      "该指派还有未结的主机操作",
    );
    return beginHostOpsActionInDraft(d, {
      tool:
        a.scope === "standing" && a.role_id === "pm"
          ? "host_ops_restart_standing_pm"
          : "host_ops_restart_assignment",
      target_id: a.id,
      reason: handoff
        ? "空闲回收已交接，核对原会话与原待办。"
        : "系统代结束的轮次门铃超期，核对归属后换会话。",
      dispatch_stall_id: p.cause_id,
      ...(p.review_trigger_id
        ? { review_trigger_id: p.review_trigger_id }
        : {}),
      snapshot: p.snapshot,
    });
  });
}

/** Existing supervisor may replace only its local, idle, managed patrol. No agent tool grants this authority. */
export function beginStalledPatrolRestart(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: HostOpsExecution["assignment_id"];
    cause_id: string;
    snapshot: NonNullable<HostOpsExecution["snapshot"]>;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const a = d.get("assignments", p.assignment_id);
    ensure(
      a.scope === "standing" &&
        a.role_id === "host_ops" &&
        a.status === "active" &&
        !a.external &&
        a.machine_id === "local" &&
        !a.worktree_path &&
        !a.runtime_ref?.worktree_path,
      "illegal_transition",
      "只能自动恢复无工作树的在岗主机运维",
    );
    ensure(
      !pendingHostOpsActions(state.events).some((p) =>
        state.events.some(
          (e) =>
            e.id === p.action_id &&
            e.actor.kind === "assignment" &&
            e.actor.assignment_id === a.id,
        ),
      ),
      "illegal_transition",
      "主机运维还有未结操作",
    );
    text(p.cause_id, "cause_id");
    return beginHostOpsActionInDraft(
      d,
      {
        tool: "host_ops_restart_assignment",
        target_id: a.id,
        reason: "主机运维通知积压，系统在空闲时换会话。",
        dispatch_stall_id: p.cause_id,
        snapshot: p.snapshot,
      },
      // C-669: the host retries only once the old session is proven gone.
      { retry_withdrawn: true },
    );
  });
}

/**
 * C-680: after an automatic restart of the patrol's own backlog was withdrawn
 * while its idle session stays live, the lightest recovery is the same as a
 * human `assignment start`: queue a Run for the original session. Nothing is
 * stopped or released; the dispatcher wakes the session through its normal
 * checks. System only; the host bounds the attempts per incident.
 */
export function nudgeStalledPatrol(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: HostOpsExecution["assignment_id"];
    cause_id: string;
    snapshot: NonNullable<HostOpsExecution["snapshot"]>;
    attempt: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "只有系统能在原会话续排主机运维的 Run",
    );
    text(p.cause_id, "cause_id");
    ensure(
      Number.isSafeInteger(p.attempt) && p.attempt > 0,
      "validation_failed",
      "attempt must be a positive integer",
    );
    const a = d.get("assignments", p.assignment_id);
    ensure(
      a.scope === "standing" &&
        a.role_id === "host_ops" &&
        a.status === "active" &&
        !a.external &&
        a.runtime_ref !== null,
      "illegal_transition",
      "只能在在岗主机运维的原会话续排 Run",
    );
    ensure(
      !stoppedByHuman(state.events, a.id) &&
        !hostOpsPending(state.events, a.id),
      "illegal_transition",
      "主机运维已被人工停止或还有未结操作",
    );
    ensure(
      !runsOf(state.runs, a.id).some(
        (r) => !["completed", "failed", "cancelled"].includes(r.status),
      ),
      "illegal_transition",
      "主机运维还有未结束的 Run",
    );
    const run = queueRunInDraft(d, {
      assignment_id: a.id,
      kind: "initial",
      model: p.snapshot.model,
      agent_cli_version: p.snapshot.agent_cli_version,
      ...(p.snapshot.launch_profile_ref
        ? { launch_profile_ref: p.snapshot.launch_profile_ref }
        : {}),
      ...(p.snapshot.harness ? { harness: p.snapshot.harness } : {}),
      ...(p.snapshot.effort ? { effort: p.snapshot.effort } : {}),
    });
    d.emit("dispatch_stall_nudged", undefined, {
      assignment_id: a.id,
      dispatch_stall_id: p.cause_id,
      run_id: run.id,
      attempt: p.attempt,
    });
    return run;
  });
}

/** C-680: the light recoveries already queued for this incident. */
export function patrolNudges(
  state: Pick<CommandState, "events">,
  assignment: HostOpsExecution["assignment_id"],
  cause: string,
) {
  return eventsOfType(state.events, "dispatch_stall_nudged").filter((e) => {
    const p = e.payload as {
      assignment_id?: string;
      dispatch_stall_id?: string;
    };
    return (
      e.actor.kind === "system" &&
      p.assignment_id === assignment &&
      p.dispatch_stall_id === cause
    );
  });
}

function recordResult(
  d: CommandDraft,
  actionId: HostOpsExecution["action_id"],
  result: "succeeded" | "failed",
  reason: string,
) {
  const intent =
    d.state.events.find(
      (e) => e.id === actionId && e.type === "host_ops_action_taken",
    ) ?? d.events.find((e) => e.id === actionId);
  if (
    !intent ||
    ((intent.payload as { automatic_context_restart?: boolean })
      .automatic_context_restart !== true &&
      !(intent.payload as { dispatch_stall_id?: string }).dispatch_stall_id) ||
    eventsOfType(d.state.events, "context_session_restart_result").some(
      (e) => (e.payload as { action_id?: string }).action_id === actionId,
    )
  )
    return;
  const action = intent.payload as unknown as HostOpsExecution;
  const usage = action.context_usage;

  const finished = eventsOfType(
    d.state.events,
    "host_ops_action_finished",
  ).find((e) => (e.payload as { action_id?: string }).action_id === actionId);
  // A stop was attempted but exit is not yet confirmed. Keep the original
  // intent/fence alive so a later lease may observe exit, never signal twice.
  if (action.system_finished_run_id && !finished && result === "failed") {
    if (
      eventsOfType(d.state.events, "host_ops_action_deferred").some(
        (e) =>
          (e.payload as { action_id?: string; notify_pm?: boolean })
            .action_id === actionId &&
          (e.payload as { notify_pm?: boolean }).notify_pm,
      )
    )
      return;
    return d.emit("host_ops_action_deferred", undefined, {
      action_id: actionId,
      assignment_id: action.assignment_id,
      reason,
      notify_pm: true,
    });
  }
  const run =
    finished &&
    d.state.runs.find(
      (r) => r.id === (finished.payload as { run_id?: string }).run_id,
    );
  // A late failure cannot override a new session that has actually started.
  if (run?.started_at) {
    result = "succeeded";
    reason = "新会话已开始执行。";
  } else if (result === "succeeded") return;
  const body = !usage
    ? `派发积压 ${action.assignment_id} 换会话${result === "succeeded" ? "成功" : "失败"}：${reason}`
    : `主机运维 ${action.assignment_id} 自动换会话${result === "succeeded" ? "成功" : "失败"}：会话 ${usage.session_id}，已用 ${usage.used_percentage}%，剩余 ${Math.round((100 - usage.used_percentage) * 10) / 10}%。${reason}`;
  const humanId =
    result === "failed"
      ? d.ids.next(d.state.project_id, "human_action")
      : undefined;
  if (humanId) {
    const current = d.get("assignments", action.assignment_id);
    // A failed successor launch is not proof that its new process exited.
    // Retain the existing confirmation fence; PM triages this exceptional
    // case first, rather than sending a stop/start task to the human.
    const triage = action.system_finished_run_id ? "pm_ops" : "human";
    const instructions = action.system_finished_run_id
      ? `${body}。请 PM 先核对新会话启动与退出记录；如需现场核实，只申请确认进程是否退出，不要求人停止或启动指派。`
      : `${body}\n1. 核对旧会话及当前会话的终端：${JSON.stringify(action.runtime_ref)}；${JSON.stringify(current.runtime_ref)}。\n2. 在所属运行时确认相关终端及 Agent 进程均已退出；无法确认时保持本事项打开。\n3. 确认退出后由人标记完成，再按既有主机流程恢复该员工。系统不自动重试这次换会话。`;
    d.put("human_actions", {
      id: humanId,
      key: humanId,
      requested_by: "system",
      status: "open",
      triage,
      blocked_work_items: [],
      instructions,
      why_human: "自动换会话只尝试一次；需要人确认退出并恢复。",
      expected_return: "回传会话身份、终端退出核实方法和结果。",
    });
    d.emit(
      "human_action_requested",
      undefined,
      {
        human_action_id: humanId,
        assignment_id: action.assignment_id,
        host_ops_action_id: actionId,
        disposition: triage,
      },
      { type: "human_action", body: instructions, human_action_id: humanId },
    );
  }
  return d.emit(
    "context_session_restart_result",
    undefined,
    {
      action_id: actionId,
      assignment_id: action.assignment_id,
      ...(usage ? { context_usage: { ...usage } } : {}),
      ...(action.dispatch_stall_id
        ? { dispatch_stall_id: action.dispatch_stall_id }
        : {}),
      ...(action.system_finished_run_id
        ? { system_finished_run_id: action.system_finished_run_id }
        : {}),
      result,
      reason,
      body,
      ...(run ? { run_id: run.id } : {}),
      ...(humanId ? { human_action_id: humanId } : {}),
    },
    { type: "system", body },
  );
}

/** One persistent result and failure fence, including after a host restart. */
export function recordAutomaticContextRestartResult(
  state: CommandState,
  actor: Actor,
  p: {
    action_id: HostOpsExecution["action_id"];
    result: "succeeded" | "failed";
    reason: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) =>
    recordResult(d, p.action_id, p.result, p.reason),
  );
}
