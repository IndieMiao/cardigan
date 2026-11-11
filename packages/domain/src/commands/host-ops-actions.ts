import type { Actor, Run } from "../entities.js";
import {
  type HOST_OPS_TOOLS,
  type HostOpsExecution,
  type HostOpsExecutionTool,
  hostOpsPending,
  pendingHostOpsActions,
} from "../host-ops.js";
import type { AssignmentId, RunId } from "../ids.js";
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
import { cancelRunDispatch, queueRunInDraft } from "./launch.js";
import { needsYouView } from "./queries.js";
import { pauseStandingInDraft } from "./standing.js";

const unfinished = (r: Run) =>
  !["completed", "failed", "cancelled"].includes(r.status);
export interface HostOpsActionParams {
  readonly tool: HostOpsExecutionTool;
  readonly target_id: AssignmentId | RunId;
  readonly reason: string;
  readonly snapshot?: HostOpsExecution["snapshot"];
}

function target(d: CommandDraft, p: HostOpsActionParams) {
  text(p.reason, "reason");
  ensure(
    /^(?:A|R)-[1-9][0-9]*$/u.test(p.target_id),
    "validation_failed",
    "A numbered target is required",
  );
  const r =
    p.tool === "host_ops_cancel_run" ? d.get("runs", p.target_id) : undefined;
  const a = d.get("assignments", r?.assignment_id ?? p.target_id);
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
  ensure(
    p.tool !== "host_ops_restart_standing_pm" ||
      (a.scope === "standing" && a.role_id === "pm"),
    "unauthorized",
    "Target must be a standing PM",
  );
  if (a.scope === "work_item") {
    const w = d.work(a.work_item_id);
    ensure(
      w.assignment_id === a.id && w.role_id === a.role_id,
      "invariant_violation",
      "Work item ownership changed",
    );
    ensure(
      !["done", "cancelled"].includes(d.card(w.card_id).status),
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
  const active = runs.filter(unfinished);
  ensure(
    active.length <= 1,
    "invariant_violation",
    "Assignment has multiple unfinished Runs",
  );
  ensure(
    !r || (unfinished(r) && active[0]?.id === r.id),
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
  return { assignment: a, run: r ?? active[0] };
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
    const { assignment: a, run } = target(d, p);
    if (p.tool !== "host_ops_cancel_run") {
      ensure(p.snapshot, "validation_failed", "Launch snapshot is required");
      text(p.snapshot.model, "model");
      text(p.snapshot.agent_cli_version, "agent_cli_version");
      if (p.snapshot.launch_profile_ref !== undefined)
        text(p.snapshot.launch_profile_ref, "launch_profile_ref");
    }
    const payload = {
      execution: true,
      tool: p.tool,
      target_id: p.target_id,
      assignment_id: a.id,
      ...(run ? { run_id: run.id } : {}),
      reason: p.reason,
      runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
      ...(p.snapshot ? { snapshot: { ...p.snapshot } } : {}),
    };
    const event = d.emit("host_ops_action_taken", undefined, payload);
    return {
      action_id: event.id,
      assignment_id: a.id,
      status: "pending" as const,
    };
  });
}

/** Host-only settlement after independently proving the recorded terminal exited. */
export function finishHostOpsAction(
  state: CommandState,
  actor: Actor,
  action_id: HostOpsExecution["action_id"],
  ports: CommandPorts,
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
    if (previous && unfinished(previous))
      cancelRunDispatch(d, previous, action.reason);
    a = d.get("assignments", a.id);
    const { session_ref: _session, ...rest } = a;
    const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
      ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
      : a.runtime_state === "running"
        ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
        : a.runtime_state;
    d.put("assignments", {
      ...(action.tool === "host_ops_restart_standing_pm" ? rest : a),
      runtime_ref: null,
      runtime_state,
    });
    const card =
      a.scope === "work_item"
        ? d.get("cards", d.get("work_items", a.work_item_id).card_id)
        : undefined;
    // A concurrent human release/closure wins. Never resurrect abandoned work.
    let run: Run | undefined;
    if (
      action.tool !== "host_ops_cancel_run" &&
      a.status !== "released" &&
      (!card || !["done", "cancelled"].includes(card.status)) &&
      (a.status === "active" || action.tool === "host_ops_restart_standing_pm")
    ) {
      if (action.tool === "host_ops_restart_standing_pm")
        pauseStandingInDraft(d, a.id);
      ensure(action.snapshot, "invariant_violation", "Missing launch snapshot");
      run = queueRunInDraft(d, {
        ...action.snapshot,
        assignment_id: a.id,
        reuse_queued: true,
        ...(action.tool === "host_ops_restart_standing_pm"
          ? { resume: true }
          : {}),
        kind: previous?.kind ?? "followup",
      });
    }
    const event = d.emit(
      "host_ops_action_finished",
      card?.id,
      {
        action_id,
        assignment_id: a.id,
        ...(run ? { run_id: run.id } : {}),
      },
      {
        type: "system",
        body: `主机运维已处理 ${action.target_id}：${action.reason}`,
      },
    );
    return { assignment_id: a.id, run, event };
  });
}

export function hostOpsReadDiagnostics(
  state: CommandState,
  actor: Actor,
  now: string,
) {
  return command(state, actor, "host_ops_read_diagnostics", undefined, (d) => ({
    needs_you: needsYouView(d, now),
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
  }));
}

export function checkHostOpsAccess(
  state: CommandState,
  actor: Actor,
  tool: (typeof HOST_OPS_TOOLS)[number],
) {
  return command(state, actor, tool, undefined, () => undefined);
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
