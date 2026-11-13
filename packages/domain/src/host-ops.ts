import type { ContextObservation } from "./context-usage.js";
import type { Event, Run, RuntimeRef, ToolName } from "./entities.js";
import type { AssignmentId, CardId, RunId } from "./ids.js";

/** Reserved domain names; MCP execution is wired separately from the role policy. */
export const HOST_OPS_TOOLS = [
  "host_ops_read_diagnostics",
  "host_ops_restart_assignment",
  "host_ops_cancel_run",
  "host_ops_recheck_merge",
  "host_ops_restart_standing_pm",
] as const satisfies readonly ToolName[];

export const HOST_OPS_FORBIDDEN_TOOLS = [
  "record_decision",
  "resolve_delegated_decision",
  "triage_human_action",
  "submit_delivery",
  "submit_review",
  "withdraw_review",
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "replace_verification_work_item",
  "assign",
  "issue_instruction",
] as const satisfies readonly ToolName[];

export const HOST_OPS_ROLE_TOOLS = [
  "whoami",
  "get_card",
  "get_updates",
  "ack_events",
  "post_comment",
  "request_human_action",
  "request_decision",
  "upload_attachment",
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
      "host_ops_read_diagnostics"
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
  readonly context_usage?: ContextObservation;
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
export function pendingHostOpsActions(
  events: readonly Event[],
): HostOpsExecution[] {
  const finished = new Set(
    events
      .filter((e) => e.type === "host_ops_action_finished")
      .map((e) => (e.payload as { action_id: string }).action_id),
  );
  return events
    .filter(
      (e) =>
        e.type === "host_ops_action_taken" &&
        (e.payload as { execution?: boolean }).execution &&
        !finished.has(e.id),
    )
    .map((e) => ({
      ...(e.payload as unknown as HostOpsExecution),
      action_id: e.id,
    }));
}
export function hostOpsPending(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  return pendingHostOpsActions(events).some(
    (a) => a.assignment_id === assignment_id,
  );
}
