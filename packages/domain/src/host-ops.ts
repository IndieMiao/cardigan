import type { ContextObservation } from "./context-usage.js";
import type { Event, Run, RuntimeRef, ToolName } from "./entities.js";
import { eventsOfType, eventsOfTypes } from "./event-index.js";
import type { AssignmentId, CardId, RunId } from "./ids.js";
import {
  remoteWorkerExitPending,
  remoteWorkerLosses,
  remoteWorkerLossReleased,
} from "./remote-worker-loss.js";
import { SHARED_FILE_TOOLS } from "./shared-files.js";

/** Reserved domain names; MCP execution is wired separately from the role policy. */
export const HOST_OPS_TOOLS = [
  "host_ops_read_diagnostics",
  "host_ops_inspect_worker",
  "host_ops_restart_assignment",
  "host_ops_cancel_run",
  "host_ops_recheck_merge",
  "host_ops_restart_standing_pm",
  "host_ops_stop_assignment",
  "host_ops_recheck_precheck",
] as const satisfies readonly ToolName[];

export const HOST_OPS_FORBIDDEN_TOOLS = [
  "record_decision",
  "resolve_delegated_decision",
  "triage_human_action",
  "complete_host_action",
  "submit_delivery",
  "request_recheck",
  "submit_review",
  "withdraw_review",
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "replace_verification_work_item",
  "replace_primary_work_item",
  "request_delivery_rework",
  "assign",
  "issue_instruction",
] as const satisfies readonly ToolName[];

export const HOST_OPS_ROLE_TOOLS = [
  "whoami",
  "get_card",
  "get_check_log",
  "read_attachment",
  "project_snapshot",
  "get_updates",
  "ack_events",
  "post_comment",
  "request_human_action",
  "request_decision",
  "upload_attachment",
  ...SHARED_FILE_TOOLS,
  "heartbeat",
  "finish_run",
  ...HOST_OPS_TOOLS,
] as const satisfies readonly ToolName[];

/** Audit envelope for the execution commands; actor/time are inherited from Event. */
export interface HostOpsActionTaken extends Event {
  readonly type: "host_ops_action_taken";
  readonly payload: {
    readonly tool: Exclude<
      (typeof HOST_OPS_TOOLS)[number],
      "host_ops_read_diagnostics" | "host_ops_inspect_worker"
    >;
    readonly target_id: AssignmentId | RunId | CardId;
    readonly reason: string;
  };
}

export type HostOpsExecutionTool =
  | "host_ops_restart_assignment"
  | "host_ops_cancel_run"
  | "host_ops_restart_standing_pm";

/** Persisted intent. Only the host consumes runtime references and launch snapshots. */
export interface HostOpsExecution {
  readonly action_id: Event["id"];
  readonly upstream_incident_id?: Event["id"];
  readonly context_usage?: ContextObservation;
  readonly automatic_context_restart?: boolean;
  /** C-745: the one extra attempt after the upstream diagnosis recovered. */
  readonly diagnosis_recovery_retry?: boolean;
  readonly dispatch_stall_id?: string;
  /**
   * C-596 automatic standing-PM restart. Kept on the intent so execution
   * never falls back to a human exit confirmation; host operations take over.
   */
  readonly standing_pm_stall?: boolean;
  readonly system_finished_run_id?: string;
  readonly retirement_handoff?: {
    readonly observe_only?: true;
    readonly phase: "waiting" | "stopping";
    readonly started_at: string;
    readonly queue_id: Run["id"];
  };
  readonly tool: HostOpsExecutionTool;
  readonly target_id: AssignmentId | RunId;
  readonly assignment_id: AssignmentId;
  readonly run_id?: RunId;
  readonly reason: string;
  readonly runtime_ref: RuntimeRef | null;
  readonly snapshot?: Pick<
    Run,
    "model" | "agent_cli_version" | "launch_profile_ref" | "harness" | "effort"
  >;
}
/** This route may preserve a verified exit, never stop a terminal that has become live. */
export function observedLocalExitCause(e: Event | undefined) {
  return (
    e?.actor.kind === "system" &&
    e.type === "bell_turn_recovery_due" &&
    (e.payload as { activity_source?: string }).activity_source ===
      "observed_local_exit"
  );
}
/**
 * C-671: every read below goes through the type index, so a finish written
 * on a closed card (a standing assignment's trigger card) still counts in the
 * `slim` command state.
 */
export function pendingHostOpsActions(
  events: readonly Event[],
): HostOpsExecution[] {
  const finished = new Set(
    eventsOfTypes(events, [
      "host_ops_action_finished",
      "context_session_restart_result",
    ]).map((e) => (e.payload as { action_id: string }).action_id),
  );
  return eventsOfType(events, "host_ops_action_taken")
    .filter(
      (e) =>
        (e.payload as { execution?: boolean }).execution && !finished.has(e.id),
    )
    .map((e) => ({
      ...(e.payload as unknown as HostOpsExecution),
      action_id: e.id,
    }));
}
/** C-221: per-snapshot memo; event arrays are immutable (see event-index.ts). */
const pendingAssignments = new WeakMap<
  readonly Event[],
  {
    readonly actions: ReadonlySet<unknown>;
    readonly fences: ReadonlySet<unknown>;
  }
>();
function pendingSets(events: readonly Event[]) {
  let pending = pendingAssignments.get(events);
  if (!pending) {
    const actions = new Set<unknown>(
      pendingHostOpsActions(events).map((a) => a.assignment_id),
    );
    for (const loss of remoteWorkerLosses(events)) {
      if (
        !remoteWorkerLossReleased(events, loss.action_id) ||
        remoteWorkerExitPending(events, loss)
      ) {
        actions.add(loss.assignment_id);
        const assigned = eventsOfType(events, "work_item_assigned").findLast(
          (e) =>
            (e.payload as { work_item_id?: string }).work_item_id ===
            loss.work_item_id,
        );
        if (assigned)
          actions.add(
            (assigned.payload as { assignment_id?: string }).assignment_id,
          );
      }
    }
    const fences = new Set<unknown>(
      openRestartFailures(events).map(
        (e) => (e.payload as { assignment_id?: string }).assignment_id,
      ),
    );
    pending = { actions, fences };
    pendingAssignments.set(events, pending);
  }
  return pending;
}
/**
 * Failed automatic restarts whose human action has not been completed by the
 * human. Only an actual human confirmation releases the failure fence.
 */
export function openRestartFailures(events: readonly Event[]): Event[] {
  const completed = new Set(
    eventsOfType(events, "human_action_completed")
      .filter((e) => e.actor.kind === "human")
      .map((e) => (e.payload as { human_action_id?: string }).human_action_id),
  );
  // C-745: the system's one extra attempt on the same session, begun after
  // the upstream diagnosis recovered, takes over its earlier failure; that
  // attempt is itself a pending action and fences until its own result.
  const recoveries = new Map<string, number>();
  for (const e of eventsOfType(events, "host_ops_action_taken")) {
    const p = e.payload as {
      diagnosis_recovery_retry?: boolean;
      assignment_id?: string;
      context_usage?: { session_id?: string };
    };
    if (p.diagnosis_recovery_retry === true && p.context_usage?.session_id)
      recoveries.set(
        `${p.assignment_id}\u0000${p.context_usage.session_id}`,
        Math.max(
          e.seq,
          recoveries.get(
            `${p.assignment_id}\u0000${p.context_usage.session_id}`,
          ) ?? 0,
        ),
      );
  }
  return eventsOfType(events, "context_session_restart_result").filter((e) => {
    const p = e.payload as {
      result?: string;
      human_action_id?: string;
      assignment_id?: string;
      context_usage?: { session_id?: string };
    };
    if (p.result !== "failed" || completed.has(p.human_action_id)) return false;
    const recovery = p.context_usage?.session_id
      ? recoveries.get(`${p.assignment_id}\u0000${p.context_usage.session_id}`)
      : undefined;
    return recovery === undefined || recovery < e.seq;
  });
}
/**
 * C-745: every open failure fence on this assignment belongs to the given
 * session, so the system's extra attempt on that session may take it over.
 */
export function restartFencesOnlyOnSession(
  events: readonly Event[],
  assignment_id: AssignmentId,
  session: string,
): boolean {
  return openRestartFailures(events).every((e) => {
    const p = e.payload as {
      assignment_id?: string;
      context_usage?: { session_id?: string };
    };
    return (
      p.assignment_id !== assignment_id ||
      p.context_usage?.session_id === session
    );
  });
}
export function hostOpsPending(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  const { actions, fences } = pendingSets(events);
  return actions.has(assignment_id) || fences.has(assignment_id);
}
/**
 * C-741: a host operation is in flight, ignoring only the failure fence of an
 * automatic restart. The human's own session restart command clears that
 * fence in the same transaction, so it may proceed past it.
 */
export function hostOpsActionPending(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  return pendingSets(events).actions.has(assignment_id);
}

const automaticLaunches = new WeakMap<
  readonly Event[],
  ReadonlyMap<unknown, HostOpsExecution>
>();
/** Locate unfinished automatic launches without rescanning history for every Run on every tick. */
export function automaticContextActionForRun(
  events: readonly Event[],
  run: Run,
): HostOpsExecution | undefined {
  let launches = automaticLaunches.get(events);
  if (!launches) {
    const results = new Set(
      eventsOfType(events, "context_session_restart_result").map(
        (e) => (e.payload as { action_id: string }).action_id,
      ),
    );
    const intents = new Map(
      eventsOfType(events, "host_ops_action_taken")
        .filter(
          (e) =>
            ((e.payload as { automatic_context_restart?: boolean })
              .automatic_context_restart ||
              (e.payload as { dispatch_stall_id?: string })
                .dispatch_stall_id) &&
            !results.has(e.id),
        )
        .map((e) => [
          e.id,
          { ...(e.payload as unknown as HostOpsExecution), action_id: e.id },
        ]),
    );
    const indexed = new Map<unknown, HostOpsExecution>();
    for (const e of eventsOfType(events, "host_ops_action_finished")) {
      const action = intents.get(
        (e.payload as { action_id: Event["id"] }).action_id,
      );
      if (action) {
        indexed.set(e.id, action);
        const run = (e.payload as { run_id?: string }).run_id;
        if (
          run &&
          (action.system_finished_run_id || action.retirement_handoff) &&
          run === action.run_id
        )
          indexed.set(`queue/${run}`, action);
      }
    }
    launches = indexed;
    automaticLaunches.set(events, launches);
  }
  return launches.get(run.trigger_event_id) ?? launches.get(`queue/${run.id}`);
}
