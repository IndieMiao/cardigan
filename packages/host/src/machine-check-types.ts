/**
 * What one machine observation concluded about the attachment tools. Stored on
 * the check job so an explicit caller that joined the observation reads the
 * same outcome. It never carries a command: callers re-derive and re-verify it.
 */
export type AgentToolsOutcome = {
  readonly status:
    | "current"
    | "automatic"
    | "held"
    | "unverifiable"
    | "staging_failed"
    | "ready";
  readonly human_action_id?: string;
  readonly key?: string;
};

export type CheckKind = "machine" | "worker";
export interface CheckResult {
  status: "passed" | "failed";
  failed_steps: readonly string[];
  /** C-599: kept so a caller that joined this check reads the same outcome. */
  agent_tools?: AgentToolsOutcome;
}
export interface MachineCheckJob {
  id: string;
  project_id: string;
  machine_id: string;
  kind: CheckKind;
  status: CheckResult["status"] | "running";
  step: string;
  started_at: string;
  checked_at: string;
  failed_steps: readonly string[];
  agent_tools?: AgentToolsOutcome;
}
