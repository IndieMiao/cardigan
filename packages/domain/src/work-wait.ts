/** A target is an existing same-project identifier, never an address or command. */
export type ResumeCondition = {
  readonly kind:
    | "precheck_finished"
    | "merge_check_finished"
    | "github_run_completed"
    | "card_merged"
    | "deployment_ready"
    | "decision_resolved";
  readonly target_id: string;
};
export type RunWaitRequest =
  | { readonly kind: "baseline_updated" }
  | { readonly kind: "deployment_ready"; readonly target_id: string };
export type RunWait = {
  readonly condition:
    | ResumeCondition
    | { readonly kind: "baseline_updated"; readonly target_id: string };
  readonly resumed_by?: import("./ids.js").EventId;
};
