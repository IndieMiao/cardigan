import type { NextOwnerItem, WaitingOnItem } from "./card-derived-types.js";
import type { Harness } from "./harness.js";
import type {
  AssignmentId,
  AttachmentId,
  CardId,
  DecisionId,
  DeliveryId,
  EmployeeId,
  EventId,
  HumanActionId,
  MachineId,
  MergeBatchId,
  ProjectId,
  ReviewId,
  RoleId,
  RunId,
  TimelineEntryId,
  WorkItemId,
} from "./ids.js";
import type { DecisionCategory } from "./preferences.js";
import type { CardPriority } from "./priority.js";
import type {
  ApprovalStatus,
  AssignmentStatus,
  CardStatus,
  DecisionStatus,
  DeliveryStatus,
  HumanActionStatus,
  MachineStatus,
  ProduceStatus,
  ReviewVerdict,
  RunStatus,
  RuntimeState,
  VerifyStatus,
} from "./states.js";
import type { StoryState } from "./story-discussion.js";

export type Timestamp = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export const toolNames = [
  "whoami",
  "get_card",
  "get_check_log",
  "get_updates",
  "ack_events",
  "post_comment",
  "issue_instruction",
  "report_blocker",
  "request_human_action",
  "request_decision",
  "upload_attachment",
  "read_attachment",
  "heartbeat",
  "finish_run",
  "submit_delivery",
  "request_recheck",
  "request_check",
  "run_probe",
  "request_mobile_signature",
  "submit_review",
  "withdraw_review",
  "request_delivery_rework",
  "create_card",
  "update_card",
  "set_merge_solo",
  "set_merge_window",
  "reserve_machine_resource",
  "create_work_item",
  "update_work_item",
  "replace_verification_work_item",
  "assign",
  "release_assignment",
  "project_snapshot",
  "list_needs_you",
  "list_templates",
  "list_roles",
  "record_decision",
  "resolve_delegated_decision",
  "triage_human_action",
  "complete_host_action",
  "host_ops_read_diagnostics",
  "host_ops_inspect_worker",
  "host_ops_restart_assignment",
  "host_ops_cancel_run",
  "host_ops_recheck_merge",
  "host_ops_restart_standing_pm",
] as const;
export type ToolName = (typeof toolNames)[number];
export type RoleWorktree = "none" | "write" | "readonly";
export interface RoleReference {
  readonly launch_profile_ref?: string;
  /** Legacy references may not declare a worktree policy. */
  readonly worktree?: RoleWorktree;
  readonly required_capabilities?: readonly string[];
  readonly required_machine_tags?: readonly string[];
  readonly role_id: RoleId;
  readonly role_version: number;
  readonly allowed_tools: readonly ToolName[];
  readonly capabilities: readonly string[];
  /** Missing on legacy versions means active. Only the latest version gates new assignments. */
  readonly status?: "active" | "inactive";
}
// Constructed by authentication, not from command parameters.
export type Actor =
  | ({
      readonly kind: "assignment";
      readonly project_id: ProjectId;
      readonly assignment_id: AssignmentId;
    } & RoleReference)
  | { readonly kind: "human" | "system"; readonly project_id: ProjectId };
export type Author = "human" | "system" | `assignment:${AssignmentId}`;
export type Decider = "human" | "system" | `role:${RoleId}`;
export type Reference =
  | { readonly kind: "card"; readonly id: CardId }
  | { readonly kind: "work_item"; readonly id: WorkItemId }
  | { readonly kind: "assignment"; readonly id: AssignmentId }
  | { readonly kind: "run"; readonly id: RunId }
  | { readonly kind: "review"; readonly id: ReviewId }
  | { readonly kind: "timeline_entry"; readonly id: TimelineEntryId }
  | { readonly kind: "decision"; readonly id: DecisionId }
  | { readonly kind: "human_action"; readonly id: HumanActionId }
  | { readonly kind: "delivery"; readonly id: DeliveryId }
  | { readonly kind: "pr"; readonly url: string };

export type RiskTag = "security" | "permission" | "numeric_rule";

export interface CardHold {
  readonly reason: string;
  readonly resume_condition: string;
  readonly set_by: Author;
  readonly set_at: Timestamp;
}

/** New UI cards explicitly distinguish display-only work from a write contract. */
export type UiStateAndSave =
  | "无写入"
  | {
      readonly save_timing: string;
      readonly leave_behavior: string;
      readonly failure_feedback: string;
      readonly consistency: string;
    };

export interface Card {
  readonly state_and_save?: UiStateAndSave;
  readonly merge_solo?: boolean;
  readonly id: CardId;
  readonly project_id: ProjectId;
  readonly title: string;
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly source:
    | { readonly kind: "quote"; readonly text: string }
    | { readonly kind: "decision"; readonly decision_id: DecisionId };
  readonly out_of_scope: readonly string[];
  readonly deadline?: Timestamp;
  readonly parent_card_id?: CardId;
  /** Stamped only for the built-in story workflow, not existing custom templates. */
  readonly story?: StoryState;
  readonly related_cards: readonly CardId[];
  readonly is_ui_framework?: boolean;
  readonly depends_on_cards?: readonly CardId[];
  readonly wait_for_dependencies?: boolean;
  readonly early_start?: {
    readonly reason: string;
    readonly set_by: Author;
    readonly set_at: Timestamp;
  };
  readonly repo?: string;
  readonly base_branch?: string;
  readonly priority: CardPriority;
  readonly status: CardStatus;
  /** Scheduling fence, independent of lifecycle and historical evidence. */
  readonly hold?: CardHold;
  readonly resolution?: "done" | "superseded" | "duplicate" | "wontdo";
  /** The replacement card, distinct from other related cards. */
  readonly superseded_by?: CardId;
  readonly template: string;
  readonly template_version?: number;
  /** Fixed at creation; legacy cards without this field use flow version 1. */
  readonly flow_version?: number;
  /** Template policy fixed at creation; legacy cards default to confirm. */
  readonly merge_policy?: "none" | "confirm" | "auto";
  /**
   * Human-only flag (C-65, §7.4): the merge confirmation of a sensitive card
   * always goes to the human, never to PM Ops or the auto-merge timeout.
   */
  readonly sensitive?: boolean;
  /** Human-only independent review requirement; risk_tags remain classification. */
  readonly high_risk?: boolean;
  /** PM/human-maintained risk classification; system may only add security from trusted paths. */
  readonly risk_tags?: readonly RiskTag[];
  /**
   * C-160: checks a human wants done before confirming the merge (e.g. an
   * independent security review). C-264 gates ordinary human confirmation on
   * their effective status; Q-440 allows an explicit, audited human override.
   * Independent review is a projection; ADR 0006 checks the actual Review and work item.
   */
  readonly pre_merge_checks?: readonly PreMergeCheck[];
  /** C-238: audit only; never authorizes or resolves a merge. */
  readonly merge_classification?: MergeClassification;
  readonly created_by: Author;
  readonly created_at: Timestamp;
}
export interface MergeClassificationInput {
  readonly checked_versions: readonly PreMergeCheckedVersion[];
  readonly read_through_seq: number;
  readonly risk_tags: readonly RiskTag[];
  readonly risk_reviewed: boolean;
  readonly is_ui: boolean;
  readonly numeric_rules_approved: boolean;
  readonly numeric_decision_ids: readonly DecisionId[];
  readonly not_external_release: boolean;
  readonly no_role_changes: boolean;
  readonly timeline_reviewed: boolean;
}
export interface MergeClassification extends MergeClassificationInput {
  readonly event_seq: number;
  readonly confirmed_by: Author;
  readonly confirmed_at: Timestamp;
}
export type PreMergeCheckStatus = "pending" | "passed" | "failed";
/** The producing deliveries a pre-merge conclusion was reached on. */
export interface PreMergeCheckedVersion {
  readonly work_item_id: WorkItemId;
  readonly delivery_id: DeliveryId;
  readonly subject: string;
  /** Source of an explicit same-commit rebind for this producing item. */
  readonly reused_from?: ReviewId;
}
export interface PreMergeCheck {
  readonly label: string;
  readonly status: PreMergeCheckStatus;
  readonly note?: string;
  readonly reused_from?: ReviewId;
  /**
   * C-160: `passed`/`failed` only hold for these versions; once any producing
   * work item has a newer delivery the check reads as pending again.
   */
  readonly checked_versions?: readonly PreMergeCheckedVersion[];
  readonly updated_by: Author;
  readonly updated_at: Timestamp;
}
/** Author checks are independent of deliveries and of final merge evidence. */
export interface Precheck {
  readonly failure_kind?: "candidate_conflict";
  readonly attempt_id: string;
  readonly assignment_id: AssignmentId;
  readonly work_item_id: WorkItemId;
  readonly card_id: CardId;
  readonly head_sha: string;
  readonly status:
    | "queued"
    | "running"
    | "passed"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "executor_unreachable"
    | "environment_failed";
  readonly branch: string;
  readonly machine_id: string;
  readonly candidate_sha?: string;
  readonly base_sha?: string;
  readonly tree_sha?: string;
  readonly executor?: MergeCheckView["executor"];
  readonly external_run?: MergeCheckView["external_run"];
  readonly checks?: MergeCheckView["checks"];
  readonly summary?: string;
  readonly log_ref?: string;
}
export type PrecheckView = Omit<Precheck, "branch" | "machine_id">;

export interface CardDependencyRef {
  readonly id: CardId;
  readonly title: string;
  readonly status: CardStatus | "unknown";
  readonly resolution?: Card["resolution"];
  readonly satisfied: boolean;
}
export interface CardDependencyView {
  readonly predecessors: readonly CardDependencyRef[];
  readonly successors: readonly CardDependencyRef[];
  readonly waiting_on: readonly CardId[];
  readonly critical_path_length: number;
}
export interface MergeStage {
  readonly stage:
    | "awaiting_confirmation"
    | "queued"
    | "held_by_window"
    | "batch_checking"
    | "bisecting"
    | "culprit"
    | "merged_in_batch";
  readonly batch_id?: string;
  readonly peers?: readonly string[];
  readonly position?: number;
  readonly protecting_card_id?: string;
  readonly card_check?: MergeCheckView;
  readonly batch_check?: MergeCheckView;
  readonly color?: number;
}
export interface CardView extends Card {
  readonly merge_stage?: MergeStage;
  readonly dependency?: CardDependencyView;
  readonly prechecks?: readonly PrecheckView[];
  readonly merge_check?: MergeCheckView;
  readonly merge_check_blockers?: readonly MergeCheckBlocker[];
  /** Derived by `deriveWaitingOn` in `card-derived.ts`. */
  readonly waiting_on: readonly WaitingOnItem[];
  /** Derived by `deriveNextOwners` in `card-derived.ts`. */
  readonly next_owners: readonly NextOwnerItem[];
  readonly open_decisions: readonly DecisionId[];
  readonly review_matrix: readonly {
    readonly delivery_id: DeliveryId;
    readonly work_item_id: WorkItemId;
    readonly target_sha: string;
    readonly review_id?: ReviewId;
    /** Original Review and delivery; no new reviewer submission is fabricated. */
    readonly reused_from?: {
      readonly review_id: ReviewId;
      readonly delivery_id: DeliveryId;
    };
    readonly verdict: ReviewVerdict | null;
    readonly followup_card_id?: CardId;
  }[];
  readonly why: string;
}
/** One continuous, host-observed prerequisite that prevents preparation. */
export interface MergeCheckBlocker {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly started_at: string;
}
export interface MergeCheckView {
  readonly level?: "single" | "card" | "batch";
  readonly batch_id?: MergeBatchId;
  readonly queue_wait?: { readonly reason: string; readonly queued_at: string };
  readonly attempt_id: string;
  readonly completion_id: DeliveryId;
  readonly candidate_sha: string;
  readonly tree_sha: string;
  /** Trusted baseline fixed at admission; legacy attempts may omit it. */
  readonly base_sha?: string;
  readonly scope?: {
    readonly kind: "docs_only" | "affected" | "full";
    readonly packages?: readonly string[];
  };
  readonly status:
    | "queued"
    | "running"
    | "passed"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "executor_unreachable";
  readonly checks: readonly {
    readonly name: string;
    readonly status:
      | "passed"
      | "failed"
      | "timed_out"
      | "interrupted"
      | "skipped"
      | "not_run";
    readonly reason?: "docs_only" | "card_tier";
    readonly exit_code?: number | null;
    readonly duration_ms?: number;
  }[];
  readonly summary?: string;
  readonly log_ref?: string;
  readonly startup_failure?: "repository_busy";
  /** Host-generated, redacted UTF-8 excerpt; at most 4 KiB. */
  readonly failure_excerpt?: string;
  /** Host-selected executor, fixed when an attempt is queued. Legacy SSH may omit it. */
  readonly executor?: {
    readonly name: string;
    readonly type: "ssh" | "github";
  };
  /** Validated external execution identity; never supplied by an Agent. */
  readonly external_run?: {
    readonly provider: "github";
    readonly run_id: number;
    readonly run_attempt: number;
    readonly html_url: string;
    readonly workflow_sha: string;
  };
  readonly updated_at: Timestamp;
  readonly recheck_requested?: boolean;
  /**
   * C-116: the check supervisor classified every failure as a timeout (for
   * example vitest "Test timed out"). Only drives the one automatic rerun; it
   * never widens PM authority over human-only merges.
   */
  readonly timeout_only?: boolean;
  /** A1b: host classified complete logs using its reviewed executor allowlist. */
  readonly infra_flaky?: boolean;
}
interface WorkItemFields {
  readonly requirements?: import("./machine-requirements.js").WorkItemRequirements;
  /** PM/human hold: system assignment and reminders skip this item. */
  readonly manual_assign?: boolean;
  readonly id: WorkItemId;
  readonly card_id: CardId;
  readonly title: string;
  readonly role_id: RoleId;
  readonly required: boolean;
  readonly depends_on: readonly WorkItemId[];
  readonly completion_criteria: readonly string[];
  readonly assignment_id?: AssignmentId;
  readonly template_key?: string;
  /** Historical verifier retained after an atomic replacement. */
  readonly replaced_by_work_item_id?: WorkItemId;
  readonly reported_blocker?: {
    readonly reason: string;
    readonly needs: "role" | "human";
    readonly reported_by: Author;
    readonly reported_at: Timestamp;
    readonly resume_when?: import("./work-wait.js").ResumeCondition;
    readonly auto_resume_disabled?: boolean;
  };
}
export type WorkItem = WorkItemFields &
  (
    | {
        readonly kind: "produce";
        readonly status: ProduceStatus;
        readonly target_work_item_id?: never;
        readonly review_plan_target?: never;
      }
    | {
        readonly kind: "verify";
        readonly status: VerifyStatus;
        /** Pending proposal this verifier can act on even without a current delivery. */
        readonly review_plan_target?: DecisionId;
        readonly target_work_item_id?: WorkItemId;
        readonly max_review_rounds: number;
      }
  );
/** Host-derived identity only; never an endpoint, credential or remote path. */
export type RuntimeTargetBinding = {
  readonly project_id: ProjectId;
  readonly machine_id: MachineId;
  readonly session: string;
  readonly generation: string;
  readonly fingerprint: string;
};
export interface RuntimeRef {
  readonly launch_generation?: {
    readonly run_id: RunId;
    readonly generation: string;
  };
  readonly machine_id: MachineId;
  readonly runtime_machine: string;
  readonly terminal_ref: string;
  readonly agent_name: string;
  readonly target?: RuntimeTargetBinding;
  readonly agent_session_id?: string;
  readonly worktree_path?: string;
  readonly branch?: string;
}
interface AssignmentFields {
  /** Backoff before a bell is claimed; no Run or launch reservation is required. */
  readonly snapshot_retry?: {
    readonly failures: number;
    readonly ready_at: Timestamp;
  };
  /** Confirmed remote loss (PM chooses source) or released first-launch failure (no workspace, use main). */
  readonly recovery?: {
    readonly previous_assignment_id: AssignmentId;
    readonly source: "main" | "backup";
    readonly backup?: {
      readonly sha: string;
      readonly at: string;
      readonly branch: string;
    };
  };
  readonly idle_retirement?: {
    readonly phase: "stopping" | "waiting";
    /** This claim cannot send signals. Absent on legacy or signal-capable claims. */
    readonly observe_only?: true;
    readonly runtime_ref: RuntimeRef;
    readonly started_at: Timestamp;
    readonly activity_at?: Timestamp;
    readonly threshold_minutes: number;
    readonly retry_at?: Timestamp;
    readonly failures: number;
    readonly evidence?: import("./runtime-types.js").RetirementEvidence;
    readonly last_failure?: "timeout" | "uncertain" | "unavailable";
    readonly notice_sent?: boolean;
  };
  readonly session_maintenance?: import("./session-maintenance-types.js").SessionMaintenance;
  /** Immutable identity; absent on legacy assignments. */
  readonly employee_id?: EmployeeId;
  readonly id: AssignmentId;
  readonly role_id: RoleId;
  readonly role_version: number;
  readonly status: AssignmentStatus;
  readonly runtime_state: RuntimeState;
  readonly machine_id: MachineId;
  readonly runtime_ref: RuntimeRef | null;
  readonly session_ref?: string;
  /** Latest accepted external context observation; replaced in the same transaction as alert decisions. */
  readonly context_patrol_cursor?: {
    readonly session_id: string;
    readonly updated_at: Timestamp;
    readonly used_percentage: number;
  };
  /** Durable fence while an idle session retires for a default role upgrade. */
  readonly role_upgrade?: {
    readonly role_version: number;
    readonly previous_runtime_ref: RuntimeRef | null;
    readonly started_at?: Timestamp;
    readonly retry_at?: Timestamp;
    readonly failures?: number;
    readonly notice_sent?: boolean;
  };
  readonly eta?: Timestamp;
  readonly worktree_path?: string;
  readonly branch?: string;
  readonly base_sha?: string;
  readonly mcp_token_id: string;
  readonly created_at: Timestamp;
  readonly released_at?: Timestamp;
  /** Last authenticated MCP call (M3.2); the watchdog of §3.3 reads it. */
  readonly last_mcp_activity_at?: Timestamp;
  /** Immutable scheduling flag; true only for standing Office assignments. */
  readonly external?: boolean;
}
/**
 * §7.1 / §10.4: PM Office and PM Ops share the `pm` role. The standing mode is
 * the durable difference between them (M4.5); it is written once by
 * `cardigan pm create --office|--ops` and never changes.
 */
export type StandingMode = "office" | "ops";
export type Assignment = AssignmentFields &
  (
    | {
        readonly scope: "work_item";
        readonly work_item_id: WorkItemId;
        readonly standing_mode?: never;
      }
    | {
        readonly scope: "standing";
        readonly work_item_id?: never;
        /** Absent only on rows written before M4.5 (backfilled once). */
        readonly standing_mode?: StandingMode;
      }
  );
export type RunOutcome = "completed" | "blocked" | "failed";
export interface Run {
  /** This Run's first bell, not a business ACK or an inbox cursor. Never inherit on recovery. */
  readonly bell_delivery?: {
    readonly run_id: RunId;
    readonly card_id?: CardId;
    readonly session_ref?: string;
    readonly review_target?: {
      readonly delivery_id: DeliveryId;
      readonly target_sha: string;
    };
    readonly received_at?: Timestamp;
    readonly sent_at?: Timestamp;
    readonly runtime_ref?: RuntimeRef;
    readonly retry_at?: Timestamp;
    /** Positive non-delivery, valid only for this exact first-write attempt. */
    readonly refused_attempt_id?: string;
    readonly idle_check_at?: Timestamp;
    readonly escalated_at?: Timestamp;
  };
  readonly failure_reason?: "provider_unavailable";
  readonly provider_probe?: {
    readonly episode: EventId;
    readonly at: Timestamp;
  };
  /** Physical resources pinned by the host at admission, not live editable requirements. */
  readonly resource_keys?: readonly string[];
  /** Q-744: fixed on the first independent queue, inherited without reset. */
  readonly recovery_policy?: {
    readonly version: 6;
    readonly root_run_id: RunId;
    readonly trigger_event_id: EventId;
    readonly card_id: CardId;
    readonly delivery_id?: DeliveryId;
  };
  /** Exact host dispatch snapshot; absent on historical executions. */
  readonly recovery_runtime?: RuntimeRef;
  /** Scope selected by the host at dispatch; never submitted by an Agent. */
  readonly test_review?: import("./test-review.js").TestReviewBinding;
  /** Host-only P2b launch facts in the existing Run journal. No credential values. */
  readonly launch_publication?: {
    readonly generation: string;
    readonly target: RuntimeTargetBinding;
    readonly phase:
      | "preparing"
      | "published"
      | "provisioning"
      | "provisioned"
      | "dispatched"
      | "started"
      | "stopping"
      | "exited";
    readonly lease_until: Timestamp;
    readonly agent_name: string;
    readonly work_dir: string;
    readonly sha: string | null;
    readonly token_id: string | null;
    readonly runtime_ref: RuntimeRef | null;
    readonly process: {
      readonly machine: string;
      readonly boot: string;
      readonly uid: number;
      readonly pid: number;
      readonly start: string;
      readonly process_group: number;
      readonly terminal: string;
    } | null;
    readonly log_offset: number;
    readonly artifacts: readonly {
      readonly sha256: string;
      readonly size: number;
      readonly evidence_name: string;
    }[];
    readonly wait: boolean;
    /** Redacted host diagnostic retained across exit recovery. */
    readonly failure_reason?: string;
    readonly provision_attempted: boolean;
  };
  /** Q-475: unique preparation retry; the cancelled source is never revived. */
  readonly preparation_retry?: {
    readonly source_run_id: RunId;
    readonly ready_at: Timestamp;
  };
  /** Explicit producer wait, consumed by host maintenance once its condition is met. */
  readonly wait_for?: import("./work-wait.js").RunWait;
  /** Accepted while disconnected; only the host can settle it after confirming this session alive. */
  readonly pending_finish?: {
    readonly outcome: RunOutcome;
    readonly summary: string;
    readonly wait_for?: import("./work-wait.js").RunWait;
    readonly runtime_ref: RuntimeRef;
    /** Actual authenticated token row ID, not Assignment.mcp_token_id's provisioning placeholder. */
    readonly token_id: string;
  };
  /** Durable automatic-stop fence; independent of bell delivery leases. */
  readonly dispatch_stop?: {
    readonly attempt_id: EventId;
    readonly runtime_ref: RuntimeRef | null;
    readonly lease_until: Timestamp;
    readonly stopping: boolean;
    /**
     * C-247: `server_restart` is the startup check for a Run a previous server
     * process dispatched whose terminal is confirmed gone; its requeue does not
     * spend the Assignment's single automatic recovery.
     */
    readonly reason:
      | "dispatch_timeout"
      | "provider_unavailable"
      | "delivery_retry_exhausted"
      | "server_restart"
      | "runtime_exited";
  };
  /** Durable host stop intent. Keeps its slot and blocks another launch until exit is confirmed. */
  readonly inactivity_stop?: {
    readonly attempt_id: string;
    readonly runtime_ref: RuntimeRef;
    readonly stopping: boolean;
    readonly lease_until: Timestamp;
  };
  /** Host scheduling metadata; only meaningful while status is queued. */
  readonly queue_reason?:
    | "concurrency_limit"
    | "runtime_unavailable"
    | "awaiting_dispatch"
    | "provider_unavailable";
  /** Start of the current queue episode; legacy rows use the creation or trigger event. */
  readonly queue_entered_at?: Timestamp;
  /** Watchdog checkpoints for this Run, updated with the diagnostic/PM notice in one transaction. */
  readonly queue_last_recheck_at?: Timestamp;
  readonly queue_notified_at?: Timestamp;
  /** Host-only target wait; elapsed time is excluded from dispatch recovery. */
  readonly dispatch_target_wait?: {
    readonly since?: Timestamp;
    readonly elapsed_ms: number;
  };
  readonly employee_id?: EmployeeId;
  /** Opaque host-keyed identity of the configuration used by the session. */
  readonly launch_fingerprint?: string;
  /** Actual launch profile; absent on legacy runs. */
  readonly launch_profile_ref?: string;
  /**
   * C-106: the harness the Run's session was launched with, snapshotted with
   * `model`; absent on legacy runs and wherever the host did not record it.
   */
  readonly harness?: Harness;
  /**
   * C-106: the reasoning effort in effect at launch, when the launch profile
   * states it unambiguously; absent when unknown.
   */
  readonly effort?: string;
  /**
   * P2a-10 A: fingerprint of the MCP tools/list the Run's session saw when it
   * started. A reused session carries its previous Run's value; absent on
   * legacy runs, which never trigger a catalog replacement.
   */
  readonly tool_catalog?: string;
  readonly id: RunId;
  readonly assignment_id: AssignmentId;
  readonly trigger_event_id: EventId;
  readonly kind: "initial" | "rework" | "decision_resumed" | "followup" | "fix";
  readonly status: RunStatus;
  readonly role_version: number;
  readonly model: string;
  readonly agent_cli_version: string;
  readonly started_at?: Timestamp;
  readonly finished_at?: Timestamp;
  readonly outcome: RunOutcome | null;
  readonly summary: string;
  readonly heartbeat_at?: Timestamp;
  readonly heartbeat_note?: string;
  readonly review_limit_changes?: readonly {
    readonly event_id: EventId;
    readonly max_review_rounds: number;
    readonly actor: Author;
    readonly at: Timestamp;
  }[];
}
export interface TimelineEntry {
  readonly id: TimelineEntryId;
  readonly short_id: TimelineEntryId;
  readonly card_id: CardId;
  readonly event_seq: number;
  readonly type:
    | "comment"
    | "instruction"
    | "delivery"
    | "review"
    | "decision_request"
    | "decision_resolved"
    | "human_action"
    | "handoff"
    | "status_change"
    | "system";
  readonly author: Author;
  readonly on_behalf_of?: Author;
  readonly work_item_id?: WorkItemId;
  readonly delivery_id?: DeliveryId;
  readonly decision_id?: DecisionId;
  readonly human_action_id?: HumanActionId;
  readonly run_id?: RunId;
  readonly reply_to?: TimelineEntryId;
  readonly refs: readonly Reference[];
  readonly supersedes?: TimelineEntryId;
  readonly retracted: boolean;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly created_at: Timestamp;
}
export interface DeliverySubject {
  readonly kind: "git_head" | "artifact_sha256" | "doc_version";
  readonly value: string;
}
export interface DeliveryEvidence {
  readonly kind: "commit" | "diff" | "test" | "attachment";
  readonly details: JsonValue;
}
export interface Delivery {
  /** Host-generated completion sources; run_id remains the primary product's provenance. */
  readonly system_completion?: {
    readonly version: 1;
    readonly binding: string;
    readonly products: readonly {
      readonly delivery_id: DeliveryId;
      readonly subject: DeliverySubject;
      readonly plain_summary: PlainSummary | null;
      readonly summary: string;
      readonly known_gaps: Delivery["known_gaps"];
    }[];
    readonly reviews: readonly {
      readonly review_id: ReviewId;
      readonly delivery_id: DeliveryId;
      readonly work_item_id: WorkItemId;
      readonly target_sha: string;
      readonly kind: Review["kind"];
      readonly issues: Review["issues"];
      readonly followup_card_id?: CardId;
      readonly attachments: Review["attachments"];
      readonly acceptance_evidence: readonly {
        readonly timeline_entry_id: string;
        readonly body: string;
      }[];
      readonly acceptance_evidence_missing: boolean;
    }[];
  };
  /** Host-only composite evidence; never accepted in tool parameters. */
  readonly test_review?: import("./test-review.js").TestReviewBinding;
  readonly id: DeliveryId;
  readonly work_item_id: WorkItemId;
  readonly run_id: RunId;
  readonly kind:
    | "code"
    | "design"
    | "doc"
    | "test_report"
    | "card_completion"
    | "other";
  readonly summary: string;
  readonly subject: DeliverySubject;
  readonly branch?: string;
  readonly pr_url?: string;
  readonly evidence: readonly DeliveryEvidence[];
  readonly test_results?: readonly {
    readonly command: string;
    readonly result: string;
  }[];
  readonly attachments: readonly AttachmentId[];
  readonly known_gaps: readonly {
    readonly description: string;
    readonly followup_card_id?: CardId;
    readonly precondition?: string;
  }[];
  readonly requested_verifiers: readonly WorkItemId[];
  /** C-202: required on card completions; carried into the merge confirmation. */
  readonly plain_summary?: PlainSummary;
  /** Control-plane provenance; never accepted from submit_delivery parameters. */
  readonly merge_conflict_event_id?: EventId;
  /** A1 recheck provenance, assigned only by the control plane. */
  readonly recheck_of?: DeliveryId;
  readonly supersedes?: DeliveryId;
  /** Host-controlled bindings to original, still-effective pass records. */
  readonly reused_reviews?: readonly ReviewId[];
  readonly status: DeliveryStatus;
}
export const REVIEW_IMPACTS = [
  "data_or_permission",
  "functional",
  "ux_only",
] as const;
export type ReviewImpact = (typeof REVIEW_IMPACTS)[number];
export const reviewImpactLabel: Readonly<Record<ReviewImpact, string>> = {
  data_or_permission: "数据或权限错误",
  functional: "功能错误",
  ux_only: "仅提示或体验",
};
export interface ReviewIssue {
  /** Server-owned ID of a shared must-fix on this delivery. */
  readonly finding_id?: string;
  /** Required for newly submitted must-fix issues; absent on legacy records. */
  readonly impact?: ReviewImpact;
  readonly severity: "critical" | "major" | "minor";
  readonly description: string;
  readonly must_fix: boolean;
  readonly pre_existing: boolean;
  readonly proof?: string;
}
export interface Review {
  readonly rejection_category?: string;
  /** Historical quota fact, preserved even when a later lease expires. */
  readonly test_review?: import("./test-review.js").TestReviewBinding;
  readonly id: ReviewId;
  readonly delivery_id: DeliveryId;
  readonly target_sha: string;
  readonly work_item_id: WorkItemId;
  readonly run_id: RunId;
  readonly kind: "code" | "design" | "test" | "replay" | "product" | "user";
  readonly issues: readonly ReviewIssue[];
  readonly verdict: ReviewVerdict;
  readonly blocking: boolean;
  readonly recheck_required: boolean;
  readonly followup_card_id?: CardId;
  readonly withdrawn?: { readonly at: string; readonly rationale: string };
  /** Captured by submitReview; legacy records without proof cannot be reused. */
  readonly reuse_basis?: {
    readonly context: string;
    readonly assignment_id: AssignmentId;
  };
  /** Eligibility never revives after requirements or identities change back. */
  readonly reuse_invalidated_at?: Timestamp;
  readonly attachments: readonly AttachmentId[];
  /**
   * Q-336 (a): an independent reviewer's UI screenshot conclusion (light,
   * dark, 390px). Projected to the "截图核对" pre-merge check only while the
   * project's `enable_reviewer_browser` switch is on.
   */
  readonly screenshot_check?: "passed" | "failed";
}
export interface ReviewView extends Review {
  readonly stale: boolean;
}
export interface MergeDecisionEvidence {
  readonly decision_id: DecisionId;
  readonly option: string;
  readonly completion_id: DeliveryId;
  readonly delivery_id: DeliveryId;
  readonly target_sha: string;
  /** PM's mapping from the selected behavior to this delivery's files/behavior. */
  readonly evidence: string;
}
export interface HumanDecidedMergeBasis {
  readonly entries: readonly (MergeDecisionEvidence & {
    readonly decision_version: string;
  })[];
  readonly preference_version: string;
}
export interface DecisionResolution {
  readonly human_decided_merge_basis?: HumanDecidedMergeBasis;
  /** C-301: server-recorded version consuming an independent review grant. */
  readonly review_limit_target?: {
    readonly delivery_id: DeliveryId;
    readonly subject: Delivery["subject"];
  };
  /** Q-440: human-only override, including the blockers observed in its transaction. */
  readonly merge_override?: {
    readonly reason: string;
    readonly blockers: readonly string[];
  };
  readonly option: string;
  readonly rationale: string;
  readonly resolved_by: Author;
  readonly via:
    | "needs_you"
    | "pm_office_chat"
    | "external"
    | "delegated"
    | "system_rule";
  readonly raw_quote: string;
  readonly via_chain: readonly Author[];
  readonly external_ref?: string;
  readonly batch?: string;
  readonly proxy_authority?: string;
  /** Notice shown to the human after a delegated resolution (§7.4). */
  readonly notice?: string;
  /** The human answered a confirmation PM Ops still held (§7.4). */
  readonly taken_over_from?: "role:pm" | "system";
  /** C-192: the human submitted the raiser's suggestion with one click. */
  readonly via_suggestion?: true;
  readonly at: Timestamp;
}
/**
 * C-192: the raiser's (or escalating PM's) suggested answer, shown to the
 * human with a one-click "按建议处理". `basis` fingerprints the card state it
 * was written against (deliveries, merge check, pre-merge checks); once that
 * changes the suggestion reads as stale and cannot be applied in one click.
 */
export interface DecisionSuggestion {
  /** Monotonic suggestion revision; legacy records read as version zero. */
  readonly version?: number;
  readonly option: string;
  readonly rationale: string;
  /** Prefilled return reason; only when `option` is `request_changes`. */
  readonly return_reason?: string;
  readonly by: Author;
  readonly at: Timestamp;
  readonly basis: string;
  /** C-303: per-card event high water marks, captured in the write transaction. */
  readonly evidence_baseline?: Readonly<Record<string, number>>;
  /** Durable reminder budget; survives refreshes and host restarts. */
  readonly progress_notice?: {
    readonly at: Timestamp;
    readonly event_ids: readonly string[];
  };
}
/**
 * C-202: plain-language summary shown above everything else on a decision
 * handed to the human (and written by producers on completion requests).
 * No internal IDs, commit hashes or interface names; `risk` is "无" when none.
 */
export interface PlainSummary {
  readonly changed: string;
  readonly impact: string;
  readonly risk: string;
}
interface DecisionFields {
  /** Control-plane binding for a consecutive-rejection decision (absent on legacy questions). */
  readonly review_intervention?: {
    readonly review_id: ReviewId;
    readonly producer_id: WorkItemId;
    readonly proposal?: TimelineEntryId;
    readonly confirmation?: TimelineEntryId;
  };
  /** System attribution: the sole personal-confirmation reason was this source. */
  readonly source_human_reason?: {
    readonly decision_id: DecisionId;
    readonly reason: string;
  };
  /** Confirming source irrelevance must not waive another existing human handoff. */
  readonly source_unrelated_human_required?: true;
  /** PM proposal only; human consent is a separate, card-bound audit event. */
  readonly source_unrelated_suggestion?: {
    readonly card_id: CardId;
    readonly source_decision_id: DecisionId;
    readonly version: number;
    readonly rationale: string;
    readonly by: Author;
    readonly at: Timestamp;
    readonly source_basis: string;
    readonly basis: string;
  };
  /** C-384: author/reviewer questions require PM triage, not extra authority. */
  readonly pm_triage?: true;
  /** Same-card/category human handoff; each source decision remains independently actionable. */
  readonly handoff_group?: string;
  /** Q-659: immutable control-plane evidence for a human-only rework request. */
  readonly rework_target?: {
    readonly work_item_id: WorkItemId;
    readonly delivery_id: DeliveryId;
    readonly target_sha: string;
    readonly review_id: ReviewId;
    readonly withdrawal_event_id: EventId;
    readonly basis: string;
  };
  /** C-310: PM semantic mapping, bound to host inventories and the current completion. */
  readonly role_rule_basis?: import("./role-rule.js").RoleRuleBasis;
  readonly id: DecisionId;
  readonly key: DecisionId;
  readonly card_id?: CardId;
  readonly raised_by: Author;
  /** Set by the control plane, never by request_decision parameters. */
  readonly trigger?:
    | "review_limit"
    | "merge_confirmation"
    | "worktree_cleanup"
    | "completion_review"
    | "accepted_delivery_rework";
  /** Scope explicitly authorized by a shared review-limit decision. Only matching rejections consume it. */
  readonly review_limit_group?: {
    readonly delivery_id: DeliveryId;
    readonly target_sha: string;
    readonly finding_ids: readonly string[];
    readonly candidate_items: readonly WorkItemId[];
  };
  /** Control-plane cleanup target; not writable by request_decision. */
  readonly assignment_id?: AssignmentId;
  readonly category?: DecisionCategory;
  /** Persisted policy evidence for decisions assigned to PM Ops. */
  readonly delegation_authority?: string;
  /**
   * Human-only decision: set when PM Ops hands a merge confirmation to the
   * human (disables auto-merge), or by the system on a template's human
   * completion review, or explicitly requested by a raiser. Such decisions
   * are never delegated to PM Ops, regardless of who raised them.
   */
  readonly human_required_reason?: string;
  /**
   * C-167: `false` only when the raiser marked a D12 decision as unrelated to
   * the merge content of its cards (no produce work item, no approval
   * target). Only a human raiser may set it; such a decision does not make
   * those cards' merge confirmations human-only. Absent means "related" (the
   * conservative default).
   */
  readonly merge_related?: false;
  readonly question: string;
  readonly context: string;
  readonly options: readonly {
    readonly key: string;
    readonly description: string;
    readonly impact: string;
  }[];
  readonly recommended: string;
  /** C-192: optional suggestion; absent keeps the decision UI unchanged. */
  readonly suggestion?: DecisionSuggestion;
  /**
   * C-202: required on every decision handed to the human from now on;
   * absent on older decisions, which keep showing `context` as before.
   */
  readonly plain_summary?: PlainSummary;
  readonly latest_by?: Timestamp;
  readonly preconditions?: readonly string[];
  readonly affected_cards: readonly CardId[];
  readonly affected_work_items: readonly WorkItemId[];
  /**
   * Existing card attachments shown with the question, in display order (§6).
   * Absent when the decision references none.
   */
  readonly attachment_ids?: readonly AttachmentId[];
  readonly blocking: boolean;
  readonly decider: Decider;
  readonly doc_refs: readonly {
    readonly path: string;
    readonly commit: string;
    readonly anchor: string;
  }[];
  readonly status: DecisionStatus;
  readonly resolution?: DecisionResolution;
  /** Explicit merge hold; retained independently of the decision authority. */
  readonly snooze?: {
    readonly reason: string;
    readonly until: Timestamp;
    readonly at: Timestamp;
    readonly by: Author;
  };
  readonly amends?: DecisionId;
  readonly superseded_by?: DecisionId;
  /** C-212: human decisions only; defers when the question is shown. */
  readonly ready_when?: ReadyCondition;
}
export type Decision = DecisionFields &
  (
    | { readonly kind: "choose" }
    | {
        readonly kind: "approve";
        readonly target:
          | { readonly delivery_id: DeliveryId }
          | { readonly subject: DeliverySubject };
      }
  );
/**
 * C-212: when a Needs You item may be shown. The item exists (and holds any
 * merge it blocks) from the start; the condition only defers when it appears.
 */
export type ReadyCondition =
  | {
      readonly kind: "card_delivery";
      readonly card_id: CardId;
      /** The card's newest delivery when the condition was set, if any. */
      readonly after?: DeliveryId;
    }
  | { readonly kind: "card_merged"; readonly card_id: CardId }
  | { readonly kind: "manual" };
export interface ReadyRelease {
  readonly at: Timestamp;
  readonly by: Author;
  readonly reason: string;
}
export interface HumanActionHandoff {
  readonly title: string;
  /** C-212: one plain line saying what the reader has to do. */
  readonly todo?: string;
  readonly summary: string;
  readonly why_human: string;
  readonly instructions: string;
  readonly expected_outcome: string;
  readonly expected_return: string;
  readonly rewritten_by: Author;
  readonly rewritten_at: Timestamp;
}
export interface HumanAction {
  readonly id: HumanActionId;
  readonly key: HumanActionId;
  readonly card_id?: CardId;
  readonly requested_by: Author;
  readonly category?: DecisionCategory;
  readonly instructions: string;
  readonly why_human: string;
  readonly expected_return: string;
  readonly triage?: "pm_ops" | "human" | "host";
  /**
   * C-212: who performs a host action. `external` (an operator outside the
   * host_ops role, e.g. an external PM Office) never wakes host_ops; absent
   * means host_ops.
   */
  readonly host_operator?: "external" | "host_ops";
  /** Explicit internal read-only diagnostic; absent on ordinary host handoffs. */
  readonly host_diagnostic?: true;
  /** Exact handoff owner (external Office, internal host ops, or fallback PM Ops). */
  readonly host_assignment_id?: AssignmentId;
  readonly cancellation?: {
    readonly reason: string;
    readonly by: Author;
    readonly at: Timestamp;
    readonly source: "human" | "card_cancelled" | "supervisor_rechecked";
  };
  readonly triage_rationale?: string;
  readonly ready_when?: ReadyCondition;
  readonly ready_released?: ReadyRelease;
  /** PM-authored presentation; the request fields above remain intact. */
  readonly handoff?: HumanActionHandoff;
  readonly due?: Timestamp;
  readonly blocked_work_items: readonly WorkItemId[];
  /**
   * C-112: holds the card's merge even without blocked work items. Absent or
   * false means a read-only escalation that leaves the merge alone.
   */
  readonly blocks_merge?: boolean;
  /** Only credential or external-account preparation can hold a merge. */
  readonly prerequisite?: "credential" | "external_account";
  readonly follow_up_work_items?: readonly WorkItemId[];
  readonly status: HumanActionStatus;
  readonly result?: {
    readonly text: string;
    readonly attachments: readonly AttachmentId[];
    readonly at: Timestamp;
  };
}
export interface Event {
  readonly id: EventId;
  readonly card_id?: CardId;
  readonly seq: number;
  readonly type: string;
  readonly actor: Actor;
  readonly payload: JsonValue;
  readonly created_at: Timestamp;
}
export interface Cursor {
  readonly assignment_id: AssignmentId;
  readonly card_id: CardId;
  readonly acked_seq: number;
}
export interface Machine {
  readonly id: MachineId;
  readonly label: string;
  readonly herdr_machine: string;
  readonly os: string;
  readonly arch: string;
  readonly tags: readonly string[];
  readonly max_assignments: number;
  readonly status: MachineStatus;
  readonly last_seen: Timestamp;
}
export interface StreamedArtifact {
  readonly blob_id: string;
  readonly run_id: RunId;
  readonly created_at: Timestamp;
  readonly expired?: {
    readonly at: Timestamp;
    readonly reason: "age" | "capacity";
  };
}
interface AttachmentFields {
  readonly streamed_artifact?: StreamedArtifact;
  readonly id: AttachmentId;
  /** Display metadata only; storage is addressed by sha256. */
  readonly original_filename?: string;
  readonly note?: string;
  readonly sha256: string;
  readonly mime: string;
  readonly size: number;
  readonly card_id: CardId;
  readonly uploaded_by: Author;
  readonly storage_path: string;
  readonly attach_to:
    | { readonly kind: "timeline_entry"; readonly id: TimelineEntryId }
    | { readonly kind: "delivery"; readonly id: DeliveryId };
  readonly supersedes?: AttachmentId;
}
export type Attachment = AttachmentFields &
  (
    | { readonly kind: "artifact"; readonly basis: DecisionId }
    | { readonly kind: "evidence"; readonly basis?: DecisionId }
  );
export type AttachmentView = Attachment & {
  readonly approval_status: ApprovalStatus;
};
