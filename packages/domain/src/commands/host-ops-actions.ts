import {
  assignmentCardId,
  runnableQueuedRun,
  standingRunDormant,
} from "../card-hold.js";
import {
  type ContextObservation,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
} from "../context-usage.js";
import type { Actor, Run } from "../entities.js";
import { eventById, eventsOfType } from "../event-index.js";
import {
  type HOST_OPS_TOOLS,
  type HostOpsExecution,
  type HostOpsExecutionTool,
  hostOpsPending,
  pendingHostOpsActions,
} from "../host-ops.js";
import type {
  AssignmentId,
  CardId,
  EventId,
  HumanActionId,
  RunId,
} from "../ids.js";
import { hasRunTarget } from "../run-target.js";
import { reviewDiscussionInstruction } from "../shared-review-wake.js";
import { transition } from "../transitions.js";
import { lastUpstreamInactivity } from "../upstream-health.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { cancelRunDispatch, queueRunInDraft, settingsValid } from "./launch.js";
import { projectPreferences } from "./preferences.js";
import { stoppedByHuman } from "./stop.js";

const unfinished = (r: Run) =>
  !["completed", "failed", "cancelled"].includes(r.status);
export interface HostOpsActionParams {
  readonly upstream_incident_id?: HostOpsExecution["action_id"];
  /** Internal system path only; never accepted by the MCP tool. */
  readonly automatic_context_restart?: boolean;
  readonly dispatch_stall_id?: string;
  /** Host-resolved original notification; never an operator-supplied event. */
  readonly review_trigger_id?: EventId;
  readonly tool: HostOpsExecutionTool;
  readonly context_usage?: ContextObservation;
  readonly context_stale_after_ms?: number;
  readonly target_id: AssignmentId | RunId;
  readonly reason: string;
  readonly snapshot?: HostOpsExecution["snapshot"];
}

function pausedReviewer(state: CommandState, id: AssignmentId) {
  const item = state.work_items.find((w) => w.assignment_id === id);
  return item?.kind === "verify" && item.status === "waiting_decision"
    ? item
    : undefined;
}

function target(d: CommandDraft, p: HostOpsActionParams) {
  text(p.reason, "reason");
  ensure(
    !d.assignment || !hostOpsPending(d.state.events, d.assignment.id),
    "illegal_transition",
    "The operator has a pending session operation",
  );
  ensure(
    /^(?:A|R)-[1-9][0-9]*$/u.test(p.target_id),
    "validation_failed",
    "A numbered target is required",
  );
  const r =
    p.tool === "host_ops_cancel_run" ? d.get("runs", p.target_id) : undefined;
  const a = d.get("assignments", r?.assignment_id ?? p.target_id);
  ensure(
    !a.role_upgrade,
    "illegal_transition",
    "Assignment role upgrade is pending",
  );
  ensure(
    !a.external && a.machine_id === "local" && a.runtime_state !== "released",
    "illegal_transition",
    "Target must be a local managed Assignment",
  );
  ensure(
    a.status === "active" ||
      (p.tool === "host_ops_restart_standing_pm" && a.status === "suspended"),
    "illegal_transition",
    "Target Assignment is not active",
  );
  // C-211: only the human resumes an Assignment the human stopped.
  ensure(
    p.tool === "host_ops_cancel_run" || !stoppedByHuman(d.state.events, a.id),
    "illegal_transition",
    "Target Assignment was stopped by the human; resume it with cardigan assignment start",
  );
  ensure(
    p.tool !== "host_ops_restart_standing_pm" ||
      (a.scope === "standing" && a.role_id === "pm"),
    "unauthorized",
    "Target must be a standing PM",
  );
  // A stall is independently revalidated against its exact notification by
  // the host before intent and signal. A generic restart has no such trigger.
  const wait = pausedReviewer(d.state, a.id);
  ensure(
    p.tool === "host_ops_cancel_run" ||
      !wait ||
      (p.dispatch_stall_id &&
        reviewDiscussionInstruction(
          wait,
          eventById(d.state.events, p.review_trigger_id),
        )),
    "illegal_transition",
    "审核正在等待拍板，不能重启",
  );
  if (a.scope === "work_item") {
    const w = d.work(a.work_item_id);
    ensure(
      w.assignment_id === a.id && w.role_id === a.role_id,
      "invariant_violation",
      "Work item ownership changed",
    );
    const card = d.card(w.card_id);
    ensure(
      p.tool === "host_ops_cancel_run" ||
        !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "Card is closed",
    );
  }
  ensure(
    d.state.roles.some(
      (role) =>
        role.role_id === a.role_id && role.role_version === a.role_version,
    ),
    "not_found",
    "Target role version is missing",
  );
  ensure(
    p.tool === "host_ops_cancel_run" || hasRunTarget(a, d.state),
    "illegal_transition",
    "验证工作项尚无当前可审交付，请等待交付后再启动",
  );
  ensure(
    !hostOpsPending(d.state.events, a.id),
    "illegal_transition",
    "A host operation is already pending",
  );
  ensure(
    !pendingHostOpsActions(d.state.events).some((action) => {
      const owner = d.get("assignments", action.assignment_id);
      return (
        a.worktree_path &&
        owner.machine_id === a.machine_id &&
        owner.worktree_path === a.worktree_path
      );
    }),
    "invariant_violation",
    "Worktree has a pending host operation",
  );
  const runs = d.list("runs").filter((run) => run.assignment_id === a.id);
  ensure(
    !runs.some((run) => run.dispatch_stop || run.inactivity_stop),
    "illegal_transition",
    "An automatic stop is in progress",
  );
  const active = runs.filter(
    (run) => unfinished(run) && !standingRunDormant(a, run),
  );
  ensure(
    active.length <= 1,
    "invariant_violation",
    "Assignment has multiple unfinished Runs",
  );
  ensure(
    !r || (unfinished(r) && (!active.length || active[0]?.id === r.id)),
    "illegal_transition",
    "Run is no longer cancellable",
  );
  ensure(
    !d.list("runs").some((run) => {
      const owner = d.get("assignments", run.assignment_id);
      return (
        owner.id !== a.id &&
        a.worktree_path &&
        owner.worktree_path === a.worktree_path &&
        owner.machine_id === a.machine_id &&
        (unfinished(run) || run.dispatch_stop || run.inactivity_stop)
      );
    }),
    "invariant_violation",
    "Worktree is in use by another Assignment",
  );
  return {
    assignment: a,
    run: r ?? active[0] ?? runnableQueuedRun(a, { ...d.state, runs }),
  };
}

/** Same fresh preflight for the read phase and the atomic intent transaction. */
export function prepareHostOpsAction(
  state: CommandState,
  actor: Actor,
  p: HostOpsActionParams,
) {
  return command(state, actor, p.tool, undefined, (d) => target(d, p));
}
export function beginHostOpsAction(
  state: CommandState,
  actor: Actor,
  p: HostOpsActionParams,
  ports: CommandPorts,
) {
  return command(state, actor, p.tool, ports, (d) => {
    ensure(
      !p.automatic_context_restart,
      "unauthorized",
      "Automatic restarts are system-only",
    );
    return beginHostOpsActionInDraft(d, p);
  });
}

/** Shared intent and target checks; the automatic entry adds its idle policy. */
export function beginHostOpsActionInDraft(
  d: CommandDraft,
  p: HostOpsActionParams,
) {
  const state = d.state;
  ensure(
    !p.automatic_context_restart || d.actor.kind === "system",
    "unauthorized",
    "Automatic restarts are system-only",
  );
  const { assignment: a, run } = target(d, p);
  const cause = eventById(state.events, p.dispatch_stall_id);
  const turn =
    cause?.type === "bell_turn_recovery_due" &&
    cause.actor.kind === "system" &&
    (cause.payload as { assignment_id: string }).assignment_id === a.id
      ? (cause.payload as { run_id: string }).run_id
      : undefined;
  if (p.dispatch_stall_id) {
    ensure(
      p.tool !== "host_ops_cancel_run" &&
        !run &&
        !a.idle_retirement &&
        !d.state.runs.some((r) => r.assignment_id === a.id && unfinished(r)),
      "illegal_transition",
      "派发积压已改变或指派不空闲",
    );
    ensure(
      !eventsOfType(state.events, "host_ops_action_taken").some((e) => {
        const prior = e.payload as {
          assignment_id?: string;
          dispatch_stall_id?: string;
          system_finished_run_id?: string;
        };
        return (
          prior.assignment_id === a.id &&
          (prior.dispatch_stall_id === p.dispatch_stall_id ||
            (!!turn && prior.system_finished_run_id === turn))
        );
      }),
      "illegal_transition",
      "此积压已请求过换会话",
    );
  }
  if (p.upstream_incident_id)
    ensure(
      !state.events.some(
        (e) =>
          e.type === "host_ops_action_taken" &&
          (e.payload as { upstream_incident_id?: string })
            .upstream_incident_id === p.upstream_incident_id &&
          (e.payload as { assignment_id?: string }).assignment_id === a.id,
      ),
      "illegal_transition",
      "本次上游事件已请求恢复该会话，不能重复恢复",
    );
  if (p.context_usage) {
    const usage = p.context_usage;
    ensure(
      p.tool !== "host_ops_cancel_run" &&
        contextObservationCurrent(a, usage, state.events) &&
        contextUsageFresh(usage, d.now, p.context_stale_after_ms ?? 600_000) &&
        contextUsageLevel(usage, projectPreferences(state)) === "restart",
      "stale_target",
      "上下文未到换会话档，或用量已过期、会话已更换",
    );
    ensure(
      !state.events.some(
        (e) =>
          e.type === "host_ops_action_taken" &&
          (e.payload as { assignment_id?: string }).assignment_id === a.id &&
          (e.payload as { context_usage?: ContextObservation }).context_usage
            ?.session_id === usage.session_id,
      ),
      "illegal_transition",
      "本会话已请求过上下文换会话",
    );
  }
  if (p.tool !== "host_ops_cancel_run" && !p.automatic_context_restart) {
    ensure(p.snapshot, "validation_failed", "Launch snapshot is required");
    text(p.snapshot.model, "model");
    text(p.snapshot.agent_cli_version, "agent_cli_version");
    settingsValid(p.snapshot);
    if (p.snapshot.launch_profile_ref !== undefined)
      text(p.snapshot.launch_profile_ref, "launch_profile_ref");
  }
  const payload = {
    execution: true,
    ...(turn ? { system_finished_run_id: turn } : {}),
    ...(p.dispatch_stall_id ? { dispatch_stall_id: p.dispatch_stall_id } : {}),
    ...(p.automatic_context_restart ? { automatic_context_restart: true } : {}),
    ...(p.upstream_incident_id
      ? { upstream_incident_id: p.upstream_incident_id }
      : {}),
    ...(p.context_usage ? { context_usage: { ...p.context_usage } } : {}),
    tool: p.tool,
    target_id: p.target_id,
    assignment_id: a.id,
    ...(run ? { run_id: run.id } : {}),
    reason: p.reason,
    runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
    ...(p.snapshot ? { snapshot: { ...p.snapshot } } : {}),
  };
  const card =
    a.scope === "work_item"
      ? d.get("work_items", a.work_item_id).card_id
      : undefined;
  const employee = state.employees?.find((e) => e.id === a.employee_id);
  const body = p.context_usage
    ? `主机运维为 ${employee?.name ?? a.id}（${a.id}）换会话 ${p.context_usage.session_id}：已用 ${p.context_usage.used_percentage}%，剩余 ${Math.round((100 - p.context_usage.used_percentage) * 10) / 10}%；已受理，等待确认退出。${p.reason}`
    : undefined;
  const event = d.emit("host_ops_action_taken", undefined, {
    ...payload,
    ...(body ? { body } : {}),
  });
  if (body && card)
    d.emit(
      "context_session_restart_requested",
      card,
      { action_id: event.id, assignment_id: a.id, body },
      { type: "system", body },
    );
  return {
    action_id: event.id,
    assignment_id: a.id,
    status: "pending" as const,
  };
}

/** Host-only settlement after independently proving the recorded terminal exited. */
export function finishHostOpsAction(
  state: CommandState,
  actor: Actor,
  action_id: HostOpsExecution["action_id"],
  ports: CommandPorts,
  stall?: {
    cause_id: string;
    card_id: CardId | null;
    review_trigger_id?: EventId;
  },
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const action = pendingHostOpsActions(state.events).find(
      (a) => a.action_id === action_id,
    );
    ensure(action, "stale_target", "Host operation is no longer pending");
    let a = d.get("assignments", action.assignment_id);
    ensure(
      JSON.stringify(a.runtime_ref) === JSON.stringify(action.runtime_ref),
      "stale_target",
      "Target runtime reference changed",
    );
    const previous = action.run_id ? d.get("runs", action.run_id) : undefined;
    if (
      previous &&
      unfinished(previous) &&
      (action.tool === "host_ops_cancel_run" ||
        !standingRunDormant(a, previous))
    )
      cancelRunDispatch(d, previous, action.reason);
    const confirmation = hostOpsExitConfirmation(state, action_id);
    if (confirmation.status === "open")
      d.put("human_actions", {
        ...d.get("human_actions", confirmation.human_action_id),
        status: unwrap(transition("human_action", "open", "cancel")),
      });
    a = d.get("assignments", a.id);
    const { session_ref: _session, ...rest } = a;
    const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
      ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
      : a.runtime_state === "running"
        ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
        : a.runtime_state;
    d.put("assignments", {
      ...(action.tool === "host_ops_restart_standing_pm" ||
      action.context_usage ||
      action.dispatch_stall_id
        ? rest
        : a),
      runtime_ref: null,
      runtime_state,
    });
    const currentStall =
      action.dispatch_stall_id === stall?.cause_id ? stall : undefined;
    // Standing stalls have no work item or previous Run. The revalidated cause
    // owns the stream: null means project, not the last card the PM visited.
    const sourceCard =
      a.scope === "standing" && currentStall
        ? currentStall.card_id
        : assignmentCardId(a, state, previous?.trigger_event_id);
    const card = sourceCard ? d.get("cards", sourceCard) : undefined;
    // A concurrent release, closure or target withdrawal wins over restarting.
    let run: Run | undefined;
    const wait = pausedReviewer(d.state, a.id);
    const trigger = eventById(state.events, currentStall?.review_trigger_id);
    if (
      action.tool !== "host_ops_cancel_run" &&
      (!action.dispatch_stall_id || currentStall) &&
      (!wait || reviewDiscussionInstruction(wait, trigger)) &&
      a.status !== "released" &&
      hasRunTarget(a, d.state) &&
      (!card || (!card.hold && !["done", "cancelled"].includes(card.status))) &&
      (a.status === "active" || action.tool === "host_ops_restart_standing_pm")
    ) {
      ensure(action.snapshot, "invariant_violation", "Missing launch snapshot");
      // C-154: an active standing PM keeps its Assignment and everything it
      // owns; only a PM the human already paused is resumed (no new handoff).
      run = queueRunInDraft(
        d,
        {
          ...action.snapshot,
          assignment_id: a.id,
          reuse_queued: true,
          ...(action.tool === "host_ops_restart_standing_pm"
            ? a.status === "suspended"
              ? { resume: true }
              : { restart_session: true }
            : {}),
          kind: previous?.kind ?? "followup",
        },
        trigger,
      );
    }
    const body = `主机运维已处理 ${action.target_id}：${action.reason}${action.context_usage ? `；会话 ${action.context_usage.session_id} 已用 ${action.context_usage.used_percentage}%，${run ? "旧会话已退出，已排新会话" : "已停止，目标无需重启"}` : ""}`;
    const event = d.emit(
      "host_ops_action_finished",
      run && state.runs.some((r) => r.id === run?.id)
        ? assignmentCardId(a, state, run.trigger_event_id)
        : card?.id,
      {
        action_id,
        ...(!run && wait ? { result: "stopped_without_restart" } : {}),
        ...(run && currentStall?.review_trigger_id
          ? { stall_review_trigger: currentStall.review_trigger_id }
          : {}),
        ...(action.context_usage
          ? {
              body,
              employee_id: a.employee_id ?? null,
              employee_name:
                state.employees?.find((e) => e.id === a.employee_id)?.name ??
                null,
              context_usage: { ...action.context_usage },
              result: run ? "new_session_queued" : "stopped_without_restart",
            }
          : {}),
        assignment_id: a.id,
        ...(run ? { run_id: run.id } : {}),
        ...(run && previous
          ? {
              previous_run_id: previous.id,
              original_trigger_event_id: previous.trigger_event_id,
            }
          : {}),
      },
      {
        type: "system",
        body,
      },
    );
    // Reusing a dormant Run must retain the original card trigger and identity.
    if (run && !state.runs.some((previous) => previous.id === run?.id)) {
      run = { ...run, trigger_event_id: event.id };
      d.put("runs", run);
    }
    return { assignment_id: a.id, run, event };
  });
}

// Only a system-issued, same-project maintenance handoff belongs in this
// diagnostic. A general Needs You entry (or a later external handoff) does not.
function workerMaintenanceHandoffs(state: CommandState, actor: Actor) {
  if (actor.kind !== "assignment" || actor.role_id !== "host_ops") return [];
  const open = state.human_actions.filter(
    (a) =>
      a.requested_by === "system" &&
      !a.card_id &&
      a.status === "open" &&
      a.triage === "host" &&
      a.host_operator === "host_ops" &&
      (!a.host_assignment_id || a.host_assignment_id === actor.assignment_id),
  );
  if (!open.length) return [];
  const ids = new Set(
    eventsOfType(state.events, "host_deployment_action_requested").flatMap(
      (e) => {
        const p = e.payload as { reason?: string; human_action_id?: string };
        return !e.card_id &&
          e.actor.kind === "system" &&
          e.actor.project_id === state.project_id &&
          p.reason === "worker_maintenance" &&
          p.human_action_id
          ? [p.human_action_id]
          : [];
      },
    ),
  );
  return open
    .filter((a) => ids.has(a.id))
    .map((a) => ({ human_action_id: a.id, instructions: a.instructions }));
}

/**
 * C-137: P2a-10 §2.3 limits diagnostics to attention, Run state, session
 * context usage, paused standing PMs and reconcile findings. The Needs You
 * view (human decisions, human action instructions) stays with PM and human.
 */
export function hostOpsReadDiagnostics(state: CommandState, actor: Actor) {
  return command(state, actor, "host_ops_read_diagnostics", undefined, () => {
    const handoffs = workerMaintenanceHandoffs(state, actor);
    return {
      ...(handoffs.length ? { worker_maintenance: handoffs } : {}),
      runs: state.runs.filter(unfinished),
      actions: pendingHostOpsActions(state.events).map((a) => ({
        action_id: a.action_id,
        tool: a.tool,
        target_id: a.target_id,
        status_reason:
          (
            state.events.findLast(
              (e) =>
                e.type === "host_ops_action_deferred" &&
                (e.payload as { action_id: string }).action_id === a.action_id,
            )?.payload as { reason?: string } | undefined
          )?.reason ?? "pending",
      })),
    };
  });
}

export function checkHostOpsAccess(
  state: CommandState,
  actor: Actor,
  tool: (typeof HOST_OPS_TOOLS)[number],
) {
  return command(state, actor, tool, undefined, () => undefined);
}

/** A queued outage recovery must not stop a session that resumed on its own. */
export function withdrawRecoveredHostOpsAction(
  state: CommandState,
  actor: Actor,
  action_id: HostOpsExecution["action_id"],
  ports: CommandPorts,
  new_incident_id?: HostOpsExecution["action_id"],
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const action = pendingHostOpsActions(state.events).find(
      (a) => a.action_id === action_id,
    );
    if (!action || action.tool === "host_ops_cancel_run") return false;
    const changed =
      new_incident_id &&
      new_incident_id !== action.upstream_incident_id &&
      state.events.some(
        (e) =>
          e.id === new_incident_id && e.type === "upstream_incident_started",
      );
    if (!changed) {
      if (
        !action.upstream_incident_id ||
        lastUpstreamInactivity(state, action.assignment_id)
      )
        return false;
      const request = state.events.find((e) => e.id === action_id);
      const assignment = d.get("assignments", action.assignment_id);
      if (
        !request ||
        !assignment.last_mcp_activity_at ||
        assignment.last_mcp_activity_at <= request.created_at
      )
        return false;
    }
    d.emit("host_ops_action_finished", undefined, {
      action_id,
      assignment_id: action.assignment_id,
      result: changed ? "withdrawn_upstream_changed" : "withdrawn_recovered",
    });
    return true;
  });
}

/** Cross-process lease for the recorded intent; a new host may resume after expiry. */
export function claimHostOpsAction(
  state: CommandState,
  actor: Actor,
  action_id: HostOpsExecution["action_id"],
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    if (
      !pendingHostOpsActions(state.events).some(
        (a) => a.action_id === action_id,
      )
    )
      return undefined;
    const last = state.events.findLast(
      (e) =>
        e.type === "host_ops_action_claimed" &&
        (e.payload as { action_id: string }).action_id === action_id,
    );
    if (last && (last.payload as { lease_until: string }).lease_until > d.now)
      return undefined;
    return d.emit("host_ops_action_claimed", undefined, {
      action_id,
      lease_until: new Date(Date.parse(d.now) + 60_000).toISOString(),
    }).id;
  });
}

/**
 * C-152: state of the human confirmation that a host operation's recorded
 * terminal has exited. Only a human completion counts; a PM triage or a
 * cancellation leaves the terminal unconfirmed.
 */
export type HostOpsExitConfirmation =
  | { readonly status: "none" }
  | {
      readonly status: "open" | "confirmed" | "rejected";
      readonly human_action_id: HumanActionId;
    };
export function hostOpsExitConfirmation(
  state: Pick<CommandState, "events" | "human_actions">,
  action_id: HostOpsExecution["action_id"],
): HostOpsExitConfirmation {
  const requested = state.events.findLast(
    (e) =>
      e.type === "human_action_requested" &&
      (e.payload as { host_ops_action_id?: string }).host_ops_action_id ===
        action_id,
  );
  if (!requested) return { status: "none" };
  const id = (requested.payload as { human_action_id: HumanActionId })
    .human_action_id;
  const action = state.human_actions.find((h) => h.id === id);
  if (action?.status === "open") return { status: "open", human_action_id: id };
  const completed = state.events.findLast(
    (e) =>
      e.type === "human_action_completed" &&
      (e.payload as { human_action_id?: string }).human_action_id === id,
  );
  return action?.status === "done" &&
    completed?.actor.kind === "human" &&
    [undefined, "exited"].includes(
      (completed.payload as { conclusion?: string }).conclusion,
    )
    ? { status: "confirmed", human_action_id: id }
    : { status: "rejected", human_action_id: id };
}

/**
 * C-152: the recorded terminal lives on a runtime this host cannot observe
 * (for example a local terminal while the server runs agent-ssh). Ask the
 * human to confirm it exited instead of deferring forever. Idempotent while a
 * request is open or already confirmed.
 */
export function requestHostOpsExitConfirmation(
  state: CommandState,
  actor: Actor,
  p: {
    readonly action_id: HostOpsExecution["action_id"];
    readonly instructions: string;
    readonly why_human: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const action = pendingHostOpsActions(state.events).find(
      (a) => a.action_id === p.action_id,
    );
    ensure(action, "stale_target", "Host operation is no longer pending");
    return requestExitConfirmationInDraft(d, {
      ...p,
      assignment_id: action.assignment_id,
    });
  });
}

/** C-430 shares C-152's human-only evidence and request format. */
export function requestExitConfirmationInDraft(
  d: CommandDraft,
  p: {
    readonly action_id: HostOpsExecution["action_id"];
    readonly assignment_id: AssignmentId;
    readonly instructions: string;
    readonly why_human: string;
    readonly renew_confirmed?: boolean;
  },
) {
  text(p.instructions, "instructions");
  text(p.why_human, "why_human");
  const current = hostOpsExitConfirmation(d.state, p.action_id);
  if (
    current.status === "open" ||
    (current.status === "confirmed" && !p.renew_confirmed)
  )
    return { human_action_id: current.human_action_id, created: false };
  const a = d.get("assignments", p.assignment_id);
  const card =
    a.scope === "work_item"
      ? d.get("work_items", a.work_item_id).card_id
      : undefined;
  const id = d.ids.next(d.state.project_id, "human_action") as HumanActionId;
  d.put("human_actions", {
    id,
    key: id,
    requested_by: "system",
    status: "open",
    ...(card ? { card_id: card } : {}),
    blocked_work_items: [],
    instructions: p.instructions,
    why_human: p.why_human,
    expected_return: "确认旧终端已退出后标记完成，并回传终端状态",
  });
  d.emit(
    "human_action_requested",
    card,
    {
      human_action_id: id,
      blocked_work_items: [],
      host_ops_action_id: p.action_id,
      assignment_id: a.id,
    },
    { type: "human_action", body: p.instructions, human_action_id: id },
  );
  return { human_action_id: id, created: true };
}

/** Evidence changed before a stall recovery touched the terminal. Drop only this intent; never release a stop already in flight. */
export function withdrawUnstartedStallRestart(
  state: CommandState,
  actor: Actor,
  actionId: HostOpsExecution["action_id"],
  ports: CommandPorts,
  reason?: string,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const action = pendingHostOpsActions(state.events).find(
      (a) => a.action_id === actionId,
    );
    if (
      !action?.dispatch_stall_id ||
      eventsOfType(state.events, "host_ops_action_deferred").some((e) => {
        const p = e.payload as { action_id: string; reason: string };
        return (
          p.action_id === actionId &&
          p.reason === "automatic_context_stop_started"
        );
      })
    )
      return;
    return d.emit("host_ops_action_finished", undefined, {
      action_id: actionId,
      assignment_id: action.assignment_id,
      result: "withdrawn_stall_changed",
      ...(reason ? { reason } : {}),
      body: "派发积压、终端或工作区证据已改变；未停止旧会话，请 PM 核对。",
    });
  });
}

/** A pause after acceptance wins until the first release. After that point
 * keep the fence and settle confirmed exit (without queuing a formal review). */
export function guardReviewRestartStop(
  state: CommandState,
  actor: Actor,
  actionId: HostOpsExecution["action_id"],
  ports: CommandPorts,
  beforeRelease: boolean,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const action = pendingHostOpsActions(state.events).find(
      (a) => a.action_id === actionId,
    );
    if (
      action?.tool !== "host_ops_restart_assignment" ||
      action.dispatch_stall_id
    )
      return false;
    if (reviewRestartStopStarted(state, actionId)) return !beforeRelease;
    if (pausedReviewer(state, action.assignment_id)) {
      d.emit("host_ops_action_finished", undefined, {
        action_id: actionId,
        assignment_id: action.assignment_id,
        result: "withdrawn_review_wait",
      });
      return false;
    }
    if (beforeRelease)
      d.emit("host_ops_action_deferred", undefined, {
        action_id: actionId,
        assignment_id: action.assignment_id,
        reason: "review_restart_stop_started",
      });
    return true;
  });
}
export function reviewRestartStopStarted(
  state: CommandState,
  actionId: string,
) {
  return eventsOfType(state.events, "host_ops_action_deferred").some((e) => {
    const p = e.payload as { action_id: string; reason: string };
    return (
      p.action_id === actionId && p.reason === "review_restart_stop_started"
    );
  });
}
