import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
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

const unfinished = (run: Run) =>
  !["completed", "failed", "cancelled"].includes(run.status);
function target(d: CommandDraft, id: AssignmentId) {
  const assignment = d.get("assignments", id);
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
      if (r.id === run_id || !unfinished(r)) return false;
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

export function queueRun(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId; model: string; agent_cli_version: string },
  ports: CommandPorts,
) {
  return command(state, actor, "queue_run", ports, (d) => {
    const assignment = target(d, p.assignment_id);
    text(p.model, "model");
    text(p.agent_cli_version, "agent_cli_version");
    exclusive(d, assignment);
    const id = d.ids.next(state.project_id, "run");
    const event = d.emit("run_queued", cardId(d, assignment), {
      run_id: id,
      assignment_id: assignment.id,
    });
    const run: Run = {
      id,
      assignment_id: assignment.id,
      trigger_event_id: event.id,
      kind: "initial",
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
  readonly run_id: RunId;
  readonly runtime_ref: RuntimeRef;
  readonly base_sha?: string;
}
export function dispatchRun(
  state: CommandState,
  actor: Actor,
  p: DispatchRunParams,
  ports: CommandPorts,
) {
  return command(state, actor, "dispatch_run", ports, (d) => {
    const run = d.get("runs", p.run_id);
    const assignment = target(d, run.assignment_id);
    snapshot(run, assignment);
    const status = unwrap(transition("run", run.status, "dispatch"));
    const ref = p.runtime_ref;
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
    let runtime = assignment.runtime_state;
    // A completed prior Run may leave the M1 runtime observation at running.
    if (runtime === "running")
      runtime = unwrap(transition("runtime", runtime, "run_finished"));
    if (runtime === "not_provisioned")
      runtime = unwrap(transition("runtime", runtime, "provision"));
    if (runtime === "provisioning")
      runtime = unwrap(transition("runtime", runtime, "provisioned"));
    runtime = unwrap(transition("runtime", runtime, "run_started"));
    d.put("assignments", {
      ...assignment,
      runtime_state: runtime,
      runtime_ref: ref,
      ...(path ? { worktree_path: path } : {}),
      ...(ref.branch ? { branch: ref.branch } : {}),
      ...(base_sha ? { base_sha } : {}),
      ...(ref.agent_session_id ? { session_ref: ref.agent_session_id } : {}),
    });
    const next = { ...run, status };
    d.put("runs", next);
    d.emit("run_dispatched", cardId(d, assignment), {
      run_id: run.id,
      assignment_id: assignment.id,
    });
    return next;
  });
}
