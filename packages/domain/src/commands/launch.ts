import { assignmentDependenciesAllowStart } from "../card-dependencies.js";
import {
  assignmentCardHeld,
  heldStandingRun,
  runnableQueuedRun,
  standingRunDormant,
} from "../card-hold.js";
import type { Actor, Assignment, Run, RuntimeRef } from "../entities.js";
import { eventById } from "../event-index.js";
import {
  automaticContextActionForRun,
  hostOpsPending,
  pendingHostOpsActions,
} from "../host-ops.js";
import type { AssignmentId, EventId, RunId } from "../ids.js";
import { newRecoveryPolicy, recoveryTargetCurrent } from "../run-recovery.js";
import { hasRunTarget } from "../run-target.js";
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
import { currentReviewTarget, reviewRound } from "./review-round.js";
import { restartStandingSession, resumeStanding } from "./standing.js";
import { incrementalTestReview } from "./test-review.js";
import { activeWork } from "./workflow.js";

const unfinished = (run: Run) =>
  !["completed", "failed", "cancelled"].includes(run.status);
function target(d: CommandDraft, id: AssignmentId) {
  const assignment = d.get("assignments", id);
  ensure(
    !assignment.role_upgrade &&
      assignment.idle_retirement?.phase !== "stopping",
    "illegal_transition",
    "Assignment role upgrade is pending",
  );
  ensure(
    d.tool === "manage_host_ops_action" || !hostOpsPending(d.state.events, id),
    "illegal_transition",
    "A host operation is pending",
  );
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
    assignment.machine_id === "local" ||
      d.state.machines?.some((machine) => machine.id === assignment.machine_id),
    "validation_failed",
    "Assignment machine is not registered",
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
function requireTestReviewBudget(d: CommandDraft, assignment: Assignment) {
  if (assignment.scope !== "work_item") return;
  const item = d.work(assignment.work_item_id);
  if (
    item.kind === "verify" &&
    currentReviewTarget(d, item)?.test_review?.verifier_id === item.id
  )
    ensure(
      reviewRound(d, item) <= item.max_review_rounds,
      "illegal_transition",
      "Review round limit has been reached after test proof recheck",
    );
}
function exclusive(
  d: CommandDraft,
  assignment: Assignment,
  run_id?: RunId,
  path = assignment.worktree_path,
) {
  ensure(
    !d
      .list("assignments")
      .some(
        (a) =>
          (a.role_upgrade || a.idle_retirement?.phase === "stopping") &&
          (a.id === assignment.id ||
            (path &&
              a.machine_id === assignment.machine_id &&
              a.worktree_path === path)),
      ),
    "illegal_transition",
    "Worktree has a pending role upgrade",
  );
  ensure(
    !pendingHostOpsActions(d.state.events).some((action) => {
      if (
        action.assignment_id === assignment.id &&
        d.tool === "manage_host_ops_action"
      )
        return false;
      const owner = d.get("assignments", action.assignment_id);
      return (
        owner.id === assignment.id ||
        (path &&
          owner.machine_id === assignment.machine_id &&
          owner.worktree_path === path)
      );
    }),
    "illegal_transition",
    "Assignment or worktree has a pending host operation",
  );
  ensure(
    !d.list("runs").some((r) => {
      if (
        r.id === run_id ||
        (!unfinished(r) &&
          !r.dispatch_stop &&
          !r.inactivity_stop &&
          (!r.launch_publication ||
            ["started", "exited"].includes(r.launch_publication.phase)))
      )
        return false;
      const owner = d.get("assignments", r.assignment_id);
      if (
        owner.id === assignment.id &&
        standingRunDormant(assignment, r) &&
        (run_id !== undefined || heldStandingRun(assignment, r, d.state))
      )
        return false;
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
interface LaunchSettingsSource {
  readonly harness?: Run["harness"] | undefined;
  readonly effort?: string | undefined;
}
/** C-106: the launch settings snapshot travels with model; absent stays absent. */
export function launchSettings(
  source: LaunchSettingsSource,
): Pick<Run, "harness" | "effort"> {
  return {
    ...(source.harness === undefined ? {} : { harness: source.harness }),
    ...(source.effort === undefined ? {} : { effort: source.effort }),
  };
}
const HARNESS_VALUES: readonly string[] = ["claude-code", "codex", "pi"];
export function settingsValid(source: LaunchSettingsSource) {
  if (source.harness !== undefined)
    ensure(
      HARNESS_VALUES.includes(source.harness),
      "validation_failed",
      "harness must be claude-code, codex or pi",
    );
  if (source.effort !== undefined) text(source.effort, "effort");
}
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
  /** Explicit host start after a standing PM pause; never set by Dispatcher. */
  readonly resume?: boolean;
  /** C-154: fresh session for an active standing PM; never pauses or hands over. */
  readonly restart_session?: boolean;
  /**
   * With restart_session: the session the host proved exited. The restart is
   * refused as stale_target when the Assignment now points at another one.
   */
  readonly expected_runtime_ref?: RuntimeRef | null;
  readonly assignment_id: AssignmentId;
  readonly model: string;
  readonly agent_cli_version: string;
  readonly launch_profile_ref?: string;
  /** C-106: launch settings snapshot; omit when unknown. */
  readonly harness?: Run["harness"] | undefined;
  readonly effort?: string | undefined;
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
    return queueRunInDraft(d, p);
  });
}
/** Shared queue transition, including ownership, snapshots and exclusivity checks. */
export function queueRunInDraft(d: CommandDraft, p: QueueRunParams) {
  const state = d.state;
  ensure(
    !(p.resume && p.restart_session),
    "validation_failed",
    "resume and restart_session are exclusive",
  );
  if (p.resume) resumeStanding(d, p.assignment_id);
  if (p.restart_session)
    restartStandingSession(
      d,
      p.assignment_id,
      p.expected_runtime_ref,
      p.reuse_queued,
    );
  const assignment = target(d, p.assignment_id);
  ensure(
    assignmentDependenciesAllowStart(d.state, assignment),
    "illegal_transition",
    "前置卡尚未完成，须等待或由 PM 明确提前开工",
  );
  ensure(
    !assignmentCardHeld(assignment, d.state, p.trigger_event_id),
    "illegal_transition",
    "卡片已暂停，请先解除暂停",
  );
  requireTestReviewBudget(d, assignment);
  ensure(
    hasRunTarget(assignment, d.state),
    "illegal_transition",
    "验证工作项尚无当前可审交付，请等待交付后再启动",
  );
  // An already emitted notification can survive a restart or upgrade. Never
  // turn a review that explicitly stopped rework into a new producer Run.
  if (p.kind === "rework" && p.trigger_event_id) {
    const trigger = eventById(state.events, p.trigger_event_id);
    ensure(
      !(
        trigger?.type === "review_submitted" &&
        (trigger.payload as { review_limit_wait?: boolean } | null)
          ?.review_limit_wait === true
      ),
      "illegal_transition",
      "审核已暂停返工，请等待决定",
    );
  }
  if (p.reuse_queued) {
    const queued = runnableQueuedRun(assignment, {
      ...d.state,
      runs: d.list("runs"),
    });
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
  settingsValid(p);
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
    ...(assignment.employee_id ? { employee_id: assignment.employee_id } : {}),
    ...(p.launch_profile_ref
      ? { launch_profile_ref: p.launch_profile_ref }
      : {}),
    ...launchSettings(p),
    trigger_event_id: p.trigger_event_id ?? event.id,
    kind: p.kind ?? "initial",
    status: "queued",
    role_version: assignment.role_version,
    model: p.model,
    agent_cli_version: p.agent_cli_version,
    outcome: null,
    summary: "",
  };
  const policy = newRecoveryPolicy(
    {
      ...d.state,
      events: [...d.state.events, ...d.events],
      work_items: d.list("work_items"),
      deliveries: d.list("deliveries"),
    },
    assignment,
    run,
  );
  const queued = policy ? { ...run, recovery_policy: policy } : run;
  d.put("runs", queued);
  return queued;
}

export interface DispatchRunParams {
  /** Exact scope used to compile first.md; null explicitly means full review. */
  readonly expected_test_review?: Run["test_review"] | null;
  /** Host compilation snapshot, recorded atomically before a queued Run starts. */
  readonly launch_snapshot?: Pick<
    Run,
    | "model"
    | "agent_cli_version"
    | "launch_profile_ref"
    | "tool_catalog"
    | "harness"
    | "effort"
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
      | "launch_profile_changed"
      | "tool_catalog_changed";
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
    ensure(
      stored.launch_publication?.phase !== "stopping",
      "illegal_transition",
      "Launch stop is in progress",
    );
    ensure(
      !stored.preparation_retry ||
        Date.parse(d.now) >= Date.parse(stored.preparation_retry.ready_at),
      "illegal_transition",
      "工作目录准备重试正在退避等待",
    );
    // C-106: a launch snapshot replaces the stored settings as a whole, so a
    // fresh session never keeps a previous session's harness or effort.
    const { harness: _harness, effort: _effort, ...unset } = stored;
    const launched: Run = p.launch_snapshot
      ? {
          ...unset,
          ...launchSettings(p.launch_snapshot),
          model: p.launch_snapshot.model,
          agent_cli_version: p.launch_snapshot.agent_cli_version,
          ...(p.launch_snapshot.launch_profile_ref
            ? { launch_profile_ref: p.launch_snapshot.launch_profile_ref }
            : {}),
          ...(p.launch_snapshot.tool_catalog
            ? { tool_catalog: p.launch_snapshot.tool_catalog }
            : {}),
        }
      : stored;
    // P2a-10 A: a Run dispatched onto the existing terminal belongs to the
    // same session, so it keeps the tools/list fingerprint that session
    // recorded (the latest started Run on the same Role version). Any entry
    // point that reuses a session (Dispatcher or CLI) therefore keeps it.
    const previous =
      p.runtime_ref === undefined
        ? d
            .list("runs")
            .filter(
              (r) =>
                r.assignment_id === launched.assignment_id &&
                r.id !== launched.id &&
                r.started_at !== undefined &&
                r.role_version === launched.role_version,
            )
            .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))[0]
        : undefined;
    const session = launched.tool_catalog === undefined ? previous : undefined;
    const catalogued =
      session?.tool_catalog !== undefined
        ? { ...launched, tool_catalog: session.tool_catalog }
        : launched;
    // C-106: likewise the harness and effort belong to the session. A Run
    // dispatched onto the existing terminal without a launch snapshot takes
    // the session's values (absent on legacy sessions), whatever was queued.
    const run: Run = (() => {
      if (previous === undefined || p.launch_snapshot !== undefined)
        return catalogued;
      const { harness: _h, effort: _e, ...rest } = catalogued;
      return { ...rest, ...launchSettings(previous) };
    })();
    if (p.launch_snapshot?.tool_catalog !== undefined)
      text(p.launch_snapshot.tool_catalog, "tool_catalog");
    if (p.launch_snapshot?.launch_profile_ref !== undefined)
      text(p.launch_snapshot.launch_profile_ref, "launch_profile_ref");
    if (p.launch_snapshot) settingsValid(p.launch_snapshot);
    const assignment = target(d, run.assignment_id);
    ensure(
      assignmentDependenciesAllowStart(d.state, assignment),
      "illegal_transition",
      "前置卡尚未完成，须等待或由 PM 明确提前开工",
    );
    ensure(
      !assignmentCardHeld(assignment, d.state, run.trigger_event_id),
      "illegal_transition",
      "卡片已暂停，请先解除暂停",
    );
    ensure(
      !run.recovery_policy ||
        run.recovery_policy.root_run_id === run.id ||
        recoveryTargetCurrent(state, run),
      "stale_target",
      "Automatic recovery business target changed",
    );
    ensure(
      hasRunTarget(assignment, d.state),
      "illegal_transition",
      "验证工作项尚无当前可审交付，请等待交付后再启动",
    );
    snapshot(run, assignment);
    const status = unwrap(transition("run", run.status, "dispatch"));
    const ref = p.runtime_ref ?? assignment.runtime_ref;
    ensure(
      ref !== null,
      "validation_failed",
      "A new terminal is needed: this Assignment has no runtime to reuse",
    );
    if (stored.launch_publication)
      ensure(
        stored.launch_publication.phase === "provisioned" &&
          ref.launch_generation?.run_id === stored.id &&
          ref.launch_generation.generation ===
            stored.launch_publication.generation &&
          JSON.stringify(ref.target) ===
            JSON.stringify(stored.launch_publication.target),
        "illegal_transition",
        "Launch must be provisioned for this Run and generation before dispatch",
      );
    ensure(
      ref.machine_id === assignment.machine_id,
      "validation_failed",
      "Runtime machine must match Assignment",
    );
    if (ref.target) {
      ensure(
        ref.target.project_id === d.state.project_id &&
          ref.target.machine_id === assignment.machine_id,
        "validation_failed",
        "Runtime binding must match project and Assignment machine",
      );
      for (const field of ["session", "generation", "fingerprint"] as const)
        text(ref.target[field], field);
    }
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
          : p.replacement.reason === "tool_catalog_changed"
            ? "部署后工具清单已变更"
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
    const contextAction = automaticContextActionForRun(state.events, run);
    if (contextAction && p.runtime_ref && !p.replacement)
      d.emit(
        "session_replaced",
        cardId(d, assignment),
        {
          assignment_id: assignment.id,
          run_id: run.id,
          reason: "context_usage",
          old_runtime_ref: contextAction.runtime_ref
            ? { ...contextAction.runtime_ref }
            : null,
          context_session_id: contextAction.context_usage?.session_id ?? null,
          action_id: contextAction.action_id,
        },
        {
          type: "handoff",
          body: "主机运维上下文到档；已确认旧会话退出，新会话先读取交接和 get_updates。",
          run_id: run.id,
        },
      );
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
    const scope =
      assignment.scope === "work_item"
        ? incrementalTestReview(
            d,
            d.work(assignment.work_item_id),
            currentReviewTarget(d, d.work(assignment.work_item_id)),
          )
        : undefined;
    requireTestReviewBudget(d, assignment);
    ensure(
      p.expected_test_review === undefined ||
        JSON.stringify(p.expected_test_review) ===
          JSON.stringify(scope ?? null),
      "stale_target",
      "Compiled review scope changed before dispatch",
    );
    const next = {
      ...run,
      ...(scope ? { test_review: scope } : {}),
      ...(run.recovery_policy ? { recovery_runtime: ref } : {}),
      status,
      ...(assignment.employee_id
        ? { employee_id: assignment.employee_id }
        : {}),
    };
    if (!scope) delete next.test_review;
    delete next.queue_reason;
    delete next.dispatch_target_wait;
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
    ensure(
      !run.recovery_policy ||
        run.recovery_policy.root_run_id === run.id ||
        recoveryTargetCurrent(state, run),
      "stale_target",
      "Automatic recovery business target changed",
    );
    requireTestReviewBudget(d, assignment);
    exclusive(d, assignment, run.id);
    if (run.test_review && assignment.scope === "work_item") {
      const item = d.work(assignment.work_item_id);
      const fresh = incrementalTestReview(
        d,
        item,
        currentReviewTarget(d, item),
      );
      ensure(
        fresh && JSON.stringify(fresh) === JSON.stringify(run.test_review),
        "stale_target",
        "Incremental review scope expired before Run start",
      );
    }
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
      ...(run.recovery_policy && run.recovery_policy.root_run_id !== run.id
        ? { recovery_root_run_id: run.recovery_policy.root_run_id }
        : {}),
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
    ensure(
      !hostOpsPending(state.events, run.assignment_id),
      "illegal_transition",
      "A host operation is pending",
    );
    return cancelRunDispatch(d, run, p.reason);
  });
}

/** Shared cancellation effect for explicit abort and confirmed automatic stops. */
export function cancelRunDispatch(
  d: CommandDraft,
  run: Run,
  reason: string,
): Run {
  if (run.status === "cancelled") return run;
  const next: Run = {
    ...run,
    status: unwrap(transition("run", run.status, "cancel")),
    outcome: "failed",
    summary: reason,
    finished_at: d.now,
  };
  const assignment = d.get("assignments", run.assignment_id);
  if (assignment.runtime_state === "running")
    d.put("assignments", {
      ...assignment,
      runtime_state: unwrap(transition("runtime", "running", "run_finished")),
      // A concurrent host abort cannot erase an automatic stop's exit target.
      runtime_ref:
        run.dispatch_stop ||
        run.inactivity_stop ||
        run.launch_publication?.phase === "stopping"
          ? assignment.runtime_ref
          : null,
    });
  d.put("runs", next);
  d.emit("run_dispatch_aborted", cardId(d, assignment), {
    run_id: run.id,
    reason,
  });
  return next;
}
