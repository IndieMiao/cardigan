import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
import type { AssignmentId, EventId, RunId } from "../ids.js";
import { EXTERNAL_ASSIGNMENT_START_ERROR } from "../standing.js";
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
import { resumeStanding } from "./standing.js";
import { activeWork } from "./workflow.js";

const unfinished = (run: Run) =>
  !["completed", "failed", "cancelled"].includes(run.status);
function target(d: CommandDraft, id: AssignmentId) {
  const assignment = d.get("assignments", id);
  ensure(
    !assignment.external,
    "validation_failed",
    EXTERNAL_ASSIGNMENT_START_ERROR,
  );
  ensure(
    assignment.status === "active",
    "illegal_transition",
    "Assignment must be active",
  );
  ensure(
    assignment.machine_id === "local",
    "validation_failed",
    "M2 supports local assignments only",
  );
  ensure(
    d.state.roles.some(
      (r) =>
        r.role_id === assignment.role_id &&
        r.role_version === assignment.role_version,
    ),
    "not_found",
    "Assignment role version was not found",
  );
  if (assignment.scope === "work_item") {
    const item = d.get("work_items", assignment.work_item_id);
    ensure(
      item.assignment_id === id && item.role_id === assignment.role_id,
      "invariant_violation",
      "Work item ownership changed",
    );
    const card = d.get("cards", item.card_id);
    ensure(
      card.project_id === d.state.project_id,
      "unauthorized",
      "Card belongs to another project",
    );
    ensure(
      !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "Card is closed",
    );
  }
  return assignment;
}
function exclusive(
  d: CommandDraft,
  assignment: Assignment,
  run_id?: RunId,
  path = assignment.worktree_path,
) {
  ensure(
    !d.list("runs").some((r) => {
      if (r.id === run_id || (!unfinished(r) && !r.inactivity_stop))
        return false;
      const owner = d.get("assignments", r.assignment_id);
      return (
        owner.id === assignment.id ||
        (path &&
          owner.machine_id === assignment.machine_id &&
          owner.worktree_path === path)
      );
    }),
    "invariant_violation",
    "Assignment or worktree already has an unfinished Run",
  );
}
const cardId = (d: CommandDraft, a: Assignment) =>
  a.scope === "work_item"
    ? d.get("work_items", a.work_item_id).card_id
    : undefined;
function snapshot(run: Run, a: Assignment) {
  ensure(
    run.role_version === a.role_version &&
      run.model.trim() &&
      run.agent_cli_version.trim(),
    "invariant_violation",
    "Run must retain its role/model/CLI snapshot",
  );
}

/** M3.2: every bell-triggered Run keeps its cause in `kind`. */
export type RunKind = Run["kind"];

export interface QueueRunParams {
  /** Explicit host start may consume the Assignment's already queued work. */
  readonly reuse_queued?: boolean;
  /** Explicit human start after a standing PM pause; never set by Dispatcher. */
  readonly resume?: boolean;
  readonly assignment_id: AssignmentId;
  readonly model: string;
  readonly agent_cli_version: string;
  readonly launch_profile_ref?: string;
  /** Defaults to `initial` (a host-started Assignment). */
  readonly kind?: RunKind;
  /**
   * The event that triggered this Run. Providing it makes the Run idempotent
   * per (Assignment, event): the store has a unique index and the domain
   * rejects the replay here, so a repeated bell never queues a second Run.
   */
  readonly trigger_event_id?: EventId;
}

export function queueRun(
  state: CommandState,
  actor: Actor,
  p: QueueRunParams,
  ports: CommandPorts,
) {
  return command(state, actor, "queue_run", ports, (d) => {
    if (p.resume) resumeStanding(d, p.assignment_id);
    const assignment = target(d, p.assignment_id);
    if (p.reuse_queued) {
      const queued = d
        .list("runs")
        .find(
          (r) => r.assignment_id === assignment.id && r.status === "queued",
        );
      if (queued) {
        exclusive(d, assignment, queued.id);
        snapshot(queued, assignment);
        return queued;
      }
    }
    text(p.model, "model");
    text(p.agent_cli_version, "agent_cli_version");
    if (p.launch_profile_ref !== undefined)
      text(p.launch_profile_ref, "launch_profile_ref");
    if (p.trigger_event_id !== undefined) {
      ensure(
        !d
          .list("runs")
          .some(
            (run) =>
              run.assignment_id === assignment.id &&
              run.trigger_event_id === p.trigger_event_id,
          ),
        "idempotency_conflict",
        "A Run already exists for this trigger event",
      );
    }
    exclusive(d, assignment);
    const id = d.ids.next(state.project_id, "run");
    const event = d.emit("run_queued", cardId(d, assignment), {
      run_id: id,
      assignment_id: assignment.id,
      kind: p.kind ?? "initial",
      ...(p.trigger_event_id === undefined
        ? {}
        : { trigger_event_id: p.trigger_event_id }),
    });
    const run: Run = {
      id,
      assignment_id: assignment.id,
      ...(assignment.employee_id
        ? { employee_id: assignment.employee_id }
        : {}),
      ...(p.launch_profile_ref
        ? { launch_profile_ref: p.launch_profile_ref }
        : {}),
      trigger_event_id: p.trigger_event_id ?? event.id,
      kind: p.kind ?? "initial",
      status: "queued",
      role_version: assignment.role_version,
      model: p.model,
      agent_cli_version: p.agent_cli_version,
      outcome: null,
      summary: "",
    };
    d.put("runs", run);
    return run;
  });
}

export interface DispatchRunParams {
  /** Host compilation snapshot, recorded atomically before a queued Run starts. */
  readonly launch_snapshot?: Pick<
    Run,
    "model" | "agent_cli_version" | "launch_profile_ref"
  >;
  readonly run_id: RunId;
  /**
   * M3.2: omit it to dispatch on the Assignment's existing terminal — the
   * bell-triggered path reuses one session, it never provisions a second one.
   */
  readonly runtime_ref?: RuntimeRef;
  readonly base_sha?: string;
  /** Host-only D5 replacement, committed together with dispatch and its handoff. */
  readonly replacement?: {
    readonly previous: RuntimeRef;
    readonly reason:
      | "runtime_not_found"
      | "runtime_unavailable"
      | "launch_profile_changed";
  };
}
export function dispatchRun(
  state: CommandState,
  actor: Actor,
  p: DispatchRunParams,
  ports: CommandPorts,
) {
  return command(state, actor, "dispatch_run", ports, (d) => {
    const stored = d.get("runs", p.run_id);
    const run = p.launch_snapshot
      ? {
          ...stored,
          model: p.launch_snapshot.model,
          agent_cli_version: p.launch_snapshot.agent_cli_version,
          ...(p.launch_snapshot.launch_profile_ref
            ? { launch_profile_ref: p.launch_snapshot.launch_profile_ref }
            : {}),
        }
      : stored;
    if (p.launch_snapshot?.launch_profile_ref !== undefined)
      text(p.launch_snapshot.launch_profile_ref, "launch_profile_ref");
    const assignment = target(d, run.assignment_id);
    snapshot(run, assignment);
    const status = unwrap(transition("run", run.status, "dispatch"));
    const ref = p.runtime_ref ?? assignment.runtime_ref;
    ensure(
      ref !== null,
      "validation_failed",
      "A new terminal is needed: this Assignment has no runtime to reuse",
    );
    ensure(
      ref.machine_id === assignment.machine_id,
      "validation_failed",
      "Runtime machine must match Assignment",
    );
    for (const field of [
      "runtime_machine",
      "terminal_ref",
      "agent_name",
    ] as const)
      text(ref[field], field);
    for (const field of [
      "worktree_path",
      "branch",
      "agent_session_id",
    ] as const)
      if (ref[field] !== undefined) text(ref[field], field);
    const path = ref.worktree_path ?? assignment.worktree_path;
    ensure(
      !assignment.worktree_path || path === assignment.worktree_path,
      "invariant_violation",
      "Restart must reuse the Assignment worktree",
    );
    ensure(
      !assignment.branch || !ref.branch || ref.branch === assignment.branch,
      "invariant_violation",
      "Restart must reuse the Assignment branch",
    );
    const base_sha = p.base_sha ?? assignment.base_sha;
    ensure(
      (!path && base_sha === undefined) ||
        (base_sha !== undefined &&
          /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(base_sha)),
      "validation_failed",
      "A worktree requires a valid base SHA",
    );
    exclusive(d, assignment, run.id, path);
    if (p.replacement) {
      ensure(
        actor.kind === "system" && p.runtime_ref !== undefined,
        "unauthorized",
        "Only the system can record a Session replacement",
      );
      ensure(
        JSON.stringify(assignment.runtime_ref) ===
          JSON.stringify(p.replacement.previous),
        "invariant_violation",
        "Session changed during replacement",
      );
      const previousRun = d
        .list("runs")
        .filter((r) => r.assignment_id === assignment.id && r.id !== run.id)
        .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))[0];
      const reason =
        p.replacement.reason === "launch_profile_changed"
          ? "员工启动配置已变更"
          : `运行时失联（${p.replacement.reason}）`;
      const body = `${reason}，替换 Session。旧 RuntimeRef：${JSON.stringify(p.replacement.previous)}。最近 Run：${previousRun?.id ?? "无"}，outcome：${previousRun?.outcome ?? "无"}。新 Session 先读卡片和 get_updates。`;
      d.emit(
        "session_replaced",
        cardId(d, assignment),
        {
          assignment_id: assignment.id,
          run_id: run.id,
          reason: p.replacement.reason,
          old_runtime_ref: { ...p.replacement.previous },
          last_run_id: previousRun?.id ?? null,
          last_outcome: previousRun?.outcome ?? null,
          handoff: body,
        },
        { type: "handoff", body, run_id: run.id },
      );
    }
    let runtime = assignment.runtime_state;
    if (p.replacement && ["unknown", "lost"].includes(runtime))
      runtime = unwrap(transition("runtime", runtime, "session_replaced"));
    // A completed prior Run may leave the M1 runtime observation at running.
    if (runtime === "running")
      runtime = unwrap(transition("runtime", runtime, "run_finished"));
    if (runtime === "not_provisioned")
      runtime = unwrap(transition("runtime", runtime, "provision"));
    if (runtime === "provisioning")
      runtime = unwrap(transition("runtime", runtime, "provisioned"));
    runtime = unwrap(transition("runtime", runtime, "run_started"));
    const nextAssignment = { ...assignment };
    if (p.replacement) delete nextAssignment.session_ref;
    d.put("assignments", {
      ...nextAssignment,
      runtime_state: runtime,
      runtime_ref: ref,
      ...(path ? { worktree_path: path } : {}),
      ...(ref.branch ? { branch: ref.branch } : {}),
      ...(base_sha ? { base_sha } : {}),
      ...(ref.agent_session_id ? { session_ref: ref.agent_session_id } : {}),
    });
    const next = {
      ...run,
      status,
      ...(assignment.employee_id
        ? { employee_id: assignment.employee_id }
        : {}),
    };
    delete next.queue_reason;
    d.put("runs", next);
    d.emit("run_dispatched", cardId(d, assignment), {
      run_id: run.id,
      assignment_id: assignment.id,
    });
    return next;
  });
}

export function acknowledgeRun(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId },
  ports: CommandPorts,
) {
  return command(state, actor, "acknowledge_run", ports, (d) => {
    const run = d.ownRun(p.run_id);
    if (run.status === "running") return run;
    const assignment = target(d, run.assignment_id);
    exclusive(d, assignment, run.id);
    let status: Run["status"] = run.status;
    if (status !== "acked")
      status = unwrap(transition("run", status, "acknowledge"));
    status = unwrap(transition("run", status, "start"));
    const next = { ...run, status, started_at: d.now };
    d.put("runs", next);
    if (assignment.scope === "work_item") {
      const item = d.ownWork(assignment.work_item_id);
      const active = activeWork(d, item);
      if (active.status !== item.status) d.put("work_items", active);
    }
    d.emit("run_started", cardId(d, assignment), {
      run_id: run.id,
      assignment_id: assignment.id,
    });
    return next;
  });
}

export function abortDispatch(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "abort_dispatch", ports, (d) => {
    text(p.reason, "reason");
    const run = d.get("runs", p.run_id);
    if (run.status === "cancelled") return run;
    const next: Run = {
      ...run,
      status: unwrap(transition("run", run.status, "cancel")),
      outcome: "failed",
      summary: p.reason,
      finished_at: d.now,
    };
    const assignment = d.get("assignments", run.assignment_id);
    if (assignment.runtime_state === "running")
      d.put("assignments", {
        ...assignment,
        runtime_state: unwrap(transition("runtime", "running", "run_finished")),
        runtime_ref: null,
      });
    d.put("runs", next);
    d.emit("run_dispatch_aborted", cardId(d, assignment), {
      run_id: run.id,
      reason: p.reason,
    });
    return next;
  });
}
