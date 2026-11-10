import type { NextOwnerItem, WaitingOnItem } from "./card-derived-types.js";
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
  ProjectId,
  ReviewId,
  RoleId,
  RunId,
  TimelineEntryId,
  WorkItemId,
} from "./ids.js";
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
  "get_updates",
  "ack_events",
  "post_comment",
  "issue_instruction",
  "report_blocker",
  "request_human_action",
  "request_decision",
  "upload_attachment",
  "heartbeat",
  "finish_run",
  "submit_delivery",
  "submit_review",
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "assign",
  "project_snapshot",
  "list_needs_you",
  "record_decision",
] as const;
export type ToolName = (typeof toolNames)[number];
export interface RoleReference {
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
export type Decider = "human" | `role:${RoleId}`;
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

export interface Card {
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
  readonly related_cards: readonly CardId[];
  readonly repo?: string;
  readonly base_branch?: string;
  readonly priority: number;
  readonly status: CardStatus;
  readonly resolution?: "done" | "superseded" | "duplicate" | "wontdo";
  /** The replacement card, distinct from other related cards. */
  readonly superseded_by?: CardId;
  readonly template: string;
  readonly template_version?: number;
  /** Template policy fixed at creation; legacy cards default to confirm. */
  readonly merge_policy?: "none" | "confirm" | "auto";
  readonly created_by: Author;
  readonly created_at: Timestamp;
}
export interface CardView extends Card {
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
    readonly verdict: ReviewVerdict | null;
  }[];
  readonly why: string;
}
interface WorkItemFields {
  readonly id: WorkItemId;
  readonly card_id: CardId;
  readonly title: string;
  readonly role_id: RoleId;
  readonly required: boolean;
  readonly depends_on: readonly WorkItemId[];
  readonly completion_criteria: readonly string[];
  readonly assignment_id?: AssignmentId;
  readonly template_key?: string;
  readonly reported_blocker?: {
    readonly reason: string;
    readonly needs: "role" | "human";
    readonly reported_by: Author;
    readonly reported_at: Timestamp;
  };
}
export type WorkItem = WorkItemFields &
  (
    | {
        readonly kind: "produce";
        readonly status: ProduceStatus;
        readonly target_work_item_id?: never;
      }
    | {
        readonly kind: "verify";
        readonly status: VerifyStatus;
        readonly target_work_item_id?: WorkItemId;
        readonly max_review_rounds: number;
      }
  );
export interface RuntimeRef {
  readonly machine_id: MachineId;
  readonly runtime_machine: string;
  readonly terminal_ref: string;
  readonly agent_name: string;
  readonly agent_session_id?: string;
  readonly worktree_path?: string;
  readonly branch?: string;
}
interface AssignmentFields {
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
  readonly eta?: Timestamp;
  readonly worktree_path?: string;
  readonly branch?: string;
  readonly base_sha?: string;
  readonly mcp_token_id: string;
  readonly created_at: Timestamp;
  readonly released_at?: Timestamp;
  /** Last authenticated MCP call (M3.2); the watchdog of §3.3 reads it. */
  readonly last_mcp_activity_at?: Timestamp;
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
  readonly employee_id?: EmployeeId;
  /** Actual launch profile; absent on legacy runs. */
  readonly launch_profile_ref?: string;
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
  /** Control-plane provenance; never accepted from submit_delivery parameters. */
  readonly merge_conflict_event_id?: EventId;
  readonly supersedes?: DeliveryId;
  readonly status: DeliveryStatus;
}
export interface ReviewIssue {
  readonly severity: "critical" | "major" | "minor";
  readonly description: string;
  readonly must_fix: boolean;
  readonly pre_existing: boolean;
  readonly proof?: string;
}
export interface Review {
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
  readonly attachments: readonly AttachmentId[];
}
export interface ReviewView extends Review {
  readonly stale: boolean;
}
export interface DecisionResolution {
  readonly option: string;
  readonly rationale: string;
  readonly resolved_by: Author;
  readonly via: "needs_you" | "pm_office_chat" | "external" | "delegated";
  readonly raw_quote: string;
  readonly via_chain: readonly Author[];
  readonly external_ref?: string;
  readonly batch?: string;
  readonly proxy_authority?: string;
  readonly at: Timestamp;
}
interface DecisionFields {
  readonly id: DecisionId;
  readonly key: DecisionId;
  readonly card_id?: CardId;
  readonly raised_by: Author;
  /** Set by the control plane, never by request_decision parameters. */
  readonly trigger?:
    | "review_limit"
    | "merge_confirmation"
    | "worktree_cleanup"
    | "completion_review";
  /** Control-plane cleanup target; not writable by request_decision. */
  readonly assignment_id?: AssignmentId;
  readonly category?:
    | "general"
    | "spending"
    | "account"
    | "permission"
    | "data_deletion";
  readonly question: string;
  readonly context: string;
  readonly options: readonly {
    readonly key: string;
    readonly description: string;
    readonly impact: string;
  }[];
  readonly recommended: string;
  readonly latest_by?: Timestamp;
  readonly preconditions?: readonly string[];
  readonly affected_cards: readonly CardId[];
  readonly affected_work_items: readonly WorkItemId[];
  readonly blocking: boolean;
  readonly decider: Decider;
  readonly doc_refs: readonly {
    readonly path: string;
    readonly commit: string;
    readonly anchor: string;
  }[];
  readonly status: DecisionStatus;
  readonly resolution?: DecisionResolution;
  readonly amends?: DecisionId;
  readonly superseded_by?: DecisionId;
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
export interface HumanAction {
  readonly id: HumanActionId;
  readonly key: HumanActionId;
  readonly card_id?: CardId;
  readonly requested_by: Author;
  readonly instructions: string;
  readonly why_human: string;
  readonly expected_return: string;
  readonly due?: Timestamp;
  readonly blocked_work_items: readonly WorkItemId[];
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
interface AttachmentFields {
  readonly id: AttachmentId;
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
