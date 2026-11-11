import type { Event, ToolName } from "./entities.js";
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
