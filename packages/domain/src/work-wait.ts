/** A target is an existing same-project identifier, never an address or command. */
export type ResumeCondition = {
  readonly kind:
    | "precheck_finished"
    | "merge_check_finished"
    | "github_run_completed"
    | "card_merged"
    | "deployment_ready"
    | "baseline_updated"
    | "decision_resolved"
    /** C-789: a resource key the work item requires; the next Run claims it at admission. */
    | "resource_available";
  readonly target_id: string;
};
export type RunWaitRequest =
  | { readonly kind: "baseline_updated" }
  | { readonly kind: "deployment_ready"; readonly target_id: string }
  | { readonly kind: "resource_available"; readonly target_id: string };
export type RunWait = {
  readonly condition: ResumeCondition;
  readonly resumed_by?: import("./ids.js").EventId;
};
/**
 * C-789: a wait registered on a delivered or accepted producer. It never
 * changes the work item's state; the system wakes the owner once when the
 * condition is met, or PM handles a registration without a condition.
 */
export type StandbyWait = {
  /** Absent: nothing the system can verify; PM decides the next step. */
  readonly condition?: ResumeCondition;
  readonly reason: string;
  /** Same shape as `Author` (kept here to avoid an entities cycle). */
  readonly registered_by:
    | "human"
    | "system"
    | `assignment:${import("./ids.js").AssignmentId}`;
  readonly registered_at: string;
  readonly run_id?: import("./ids.js").RunId;
  /** Registered by the system for a Run that ended blocked without a next step. */
  readonly auto_registered?: true;
  /** The same condition already resumed this item once; PM decides. */
  readonly auto_resume_disabled?: true;
};
