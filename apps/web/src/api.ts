export interface MemberView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly avatar: string | null;
}
export interface AuthorView {
  readonly member?: MemberView | null;
  readonly employee?: {
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly avatar: string | null;
    readonly bio?: string;
    readonly role_id?: string;
  } | null;
  readonly author_display?: string;
  readonly author?: string;
  readonly author_role?: string | null;
}

import {
  browserStream,
  type StreamCallbacks,
  type StreamFactory,
  subscribeProject,
} from "./stream.js";
/**
 * The Workbench API client (M5 plan §3.1, §3.2, §4 M5.1/M5.3).
 *
 * The session lives in an HttpOnly cookie the browser attaches by itself, so
 * this module never sees, stores or forwards a token. Every call is same-origin
 * with `credentials: "same-origin"`; a non-GET request carries the JSON
 * `Content-Type` the server requires and the browser adds the matching
 * `Origin`, which is what the CSRF check looks at.
 */

export interface SessionInfo {
  readonly authenticated: boolean;
  readonly password_configured: boolean;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

export interface WaitingOnItem {
  readonly kind: "decision" | "human_action" | "review" | "blocked";
  readonly ref: string;
  readonly label: string;
}

export interface NextOwnerItem extends AuthorView {
  readonly kind: "human" | "role" | "assignment";
  readonly ref: string;
}

export type CardStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "awaiting_merge"
  | "done"
  | "cancelled";

/** The card view the API returns; `status`, `why` and `next_owners` are derived. */
export interface CardView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly status: CardStatus;
  readonly resolution?: "done" | "superseded" | "duplicate" | "wontdo";
  readonly superseded_by?: string;
  /** C-65: human-only flag; its merge confirmation always goes to the human. */
  readonly sensitive?: boolean;
  readonly priority: number;
  readonly repo: string;
  readonly base_branch: string;
  readonly created_at: string;
  readonly deadline?: string;
  readonly why: string;
  readonly waiting_on: readonly WaitingOnItem[];
  readonly next_owners: readonly NextOwnerItem[];
  readonly related_cards: readonly string[];
  readonly source?:
    | { readonly kind: "quote"; readonly text: string }
    | { readonly kind: "decision"; readonly decision_id: string };
}

/** A list row: the card plus the fields the list filters and columns need. */
export interface CardListItem extends CardView {
  readonly queued_runs?: readonly {
    readonly run_id: string;
    readonly assignment_id: string;
    readonly ahead: number;
  }[];
  readonly produce_owners?: readonly AuthorView[];
  readonly participants?: readonly AuthorView[];
  readonly work_items?: readonly Pick<
    WorkItemView,
    "id" | "title" | "status"
  >[];
  readonly attachment_count?: number;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly updated_at: string;
  readonly roles: readonly string[];
}

/**
 * A reference the server resolved for a body (`references` of a timeline entry).
 * `exists` decides whether it may become a link: an identifier that names
 * nothing stays text (M5 plan §3.4).
 */
export interface ResolvedReference {
  readonly kind:
    | "card"
    | "timeline_entry"
    | "decision"
    | "human_action"
    | "delivery";
  readonly id: string;
  readonly exists: boolean;
  readonly status: string | null;
  readonly card_id?: string;
}

/** A reference an Agent put in a body, as stored on the entry itself. */
export type Reference =
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "timeline_entry"; readonly id: string }
  | { readonly kind: "decision"; readonly id: string }
  | { readonly kind: "human_action"; readonly id: string }
  | { readonly kind: "delivery"; readonly id: string }
  | { readonly kind: "pr"; readonly url: string };

export interface WorkItemView {
  readonly id: string;
  readonly card_id: string;
  readonly title: string;
  readonly kind: "produce" | "verify";
  readonly role_id: string;
  readonly required: boolean;
  readonly status: string;
  readonly depends_on: readonly string[];
  readonly completion_criteria: readonly string[];
  readonly assignment_id?: string;
  readonly target_work_item_id?: string;
}

export interface TimelineEntryView extends AuthorView {
  readonly merge_check?: MergeCheckView;
  readonly id: string;
  readonly card_id: string;
  readonly event_seq: number;
  readonly event_type?: string | null;
  readonly author_role?: string | null;
  readonly review_id?: string;
  readonly attachment_id?: string;
  readonly decision_option?: string;
  readonly decision_via?: "delegated";
  /** Who answered a delegated decision: PM Ops (C-37/C-49) or the system timeout. */
  readonly decision_delegate?: "pm" | "system";
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
  readonly author: string;
  readonly work_item_id?: string;
  readonly delivery_id?: string;
  readonly decision_id?: string;
  readonly human_action_id?: string;
  /** What the body spelled; the server-resolved form is `references`. */
  readonly refs: readonly Reference[];
  /** Resolved references with existence and status (`references` in JSON). */
  readonly references: readonly ResolvedReference[];
  readonly supersedes?: string;
  readonly retracted: boolean;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly created_at: string;
}

export interface DeliveryView extends AuthorView {
  readonly id: string;
  readonly work_item_id: string;
  readonly kind: string;
  readonly summary: string;
  readonly subject: { readonly kind: string; readonly value: string };
  readonly branch?: string;
  readonly pr_url?: string;
  readonly status: string;
  readonly supersedes?: string;
  readonly test_results?: readonly { command: string; result: string }[];
  readonly evidence?: readonly { kind: string; details: unknown }[];
  readonly known_gaps?: readonly {
    description: string;
    followup_card_id?: string;
  }[];
}

export interface ReviewView extends AuthorView {
  readonly id: string;
  readonly delivery_id: string;
  readonly work_item_id: string;
  readonly verdict: string;
  readonly blocking: boolean;
  readonly target_sha?: string;
  readonly issues?: readonly {
    severity: string;
    description: string;
    must_fix: boolean;
    pre_existing: boolean;
    proof?: string;
  }[];
  readonly recheck_required?: boolean;
}

export interface ReviewMatrixRow {
  readonly delivery_id: string;
  readonly work_item_id: string;
  readonly target_sha: string;
  readonly review_id?: string;
  readonly verdict: string | null;
}

/** C-72: whether the flag actually changed, and the unchanged due time if not. */
export interface SensitiveResult {
  readonly changed: boolean;
  readonly auto_merge_due_at: string | null;
}

export interface DecisionView {
  readonly auto_merge?: {
    readonly minutes: number;
    readonly due_at: string;
    /** C-154: time left when the view was read (countdown may restart). */
    readonly remaining_ms?: number;
  } | null;
  readonly trigger?: string | null;
  readonly id: string;
  readonly question: string;
  readonly status: string;
  readonly blocking: boolean;
  readonly decider: string;
  readonly decider_view?: AuthorView | null;
  readonly options: readonly {
    readonly key: string;
    readonly description: string;
    readonly impact: string;
  }[];
  readonly recommended: string;
  readonly context?: string;
  /** Card attachments the requester referenced, in display order (§6). */
  readonly attachments?: readonly AttachmentView[];
  readonly resolution?: AuthorView & {
    option: string;
    rationale: string;
    raw_quote: string;
    at: string;
  };
}

export interface HumanActionHandoffView {
  readonly title: string;
  readonly summary: string;
  readonly why_human: string;
  readonly instructions: string;
  readonly expected_outcome: string;
  readonly expected_return: string;
  readonly rewritten_by: string;
  readonly rewritten_at: string;
}
export interface HumanActionView {
  readonly handoff?: HumanActionHandoffView;
  readonly id: string;
  readonly instructions: string;
  readonly why_human: string;
  readonly expected_return: string;
  readonly status: string;
}

/** Attachment metadata; the blob is a separate request (`download_path`). */
export interface AttachmentView extends AuthorView {
  readonly id: string;
  readonly original_filename?: string;
  readonly note?: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to: { readonly kind: string; readonly id: string };
  readonly uploaded_by: string;
  readonly uploader_role?: string | null;
  readonly uploaded_at?: string | null;
  readonly basis: { readonly id: string; readonly status: string } | null;
  readonly supersedes: string | null;
  readonly inline: boolean;
  readonly download_path: string;
}

export interface CardRelations {
  readonly source_card?: {
    readonly id: string;
    readonly title: string;
    readonly decision_id: string;
  } | null;
  readonly decisions: readonly {
    readonly id: string;
    readonly question: string;
    readonly status: string;
    readonly blocking: boolean;
    readonly decider: string;
  }[];
  readonly cards: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
  }[];
  readonly pull_requests: readonly {
    readonly delivery_id: string;
    readonly work_item_id: string;
    readonly status: string;
    readonly pr_url: string;
  }[];
}

export interface CardDetail {
  /** Whether the project has an active default recipient for human comments. */
  readonly has_pm_ops?: boolean;
  readonly merge_confirmations?: readonly NeedsDecision[];
  readonly template?: TemplateView | null;
  readonly mark_done?: { allowed: boolean; reason: string | null } | null;
  readonly updated_at?: string;
  readonly recent_conclusions?: readonly TimelineEntryView[];
  readonly project_id: string;
  readonly card: CardView;
  readonly work_items: readonly WorkItemView[];
  readonly timeline: readonly TimelineEntryView[];
  readonly deliveries: readonly DeliveryView[];
  readonly reviews: readonly ReviewView[];
  readonly review_matrix: readonly ReviewMatrixRow[];
  readonly decisions: readonly DecisionView[];
  readonly human_actions: readonly HumanActionView[];
  readonly attachments: readonly AttachmentView[];
  readonly relations: CardRelations;
  readonly counts: {
    readonly timeline: number;
    readonly deliveries: number;
    readonly reviews: number;
    readonly open_decisions: number;
  };
}

export interface CommentInput {
  readonly body: string;
  readonly work_item_id?: string;
  readonly mentions?: readonly string[];
}

/** The timeline entry `postComment` returns. */
export interface PostedComment {
  readonly id: string;
  readonly body: string;
  readonly created_at: string;
}

export interface UploadAttachmentInput {
  /** Canonical padded base64. */
  readonly file: string;
  readonly original_filename?: string;
  readonly note?: string;
  readonly mime: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to:
    | { readonly kind: "timeline_entry"; readonly id: string }
    | { readonly kind: "delivery"; readonly id: string };
  readonly basis?: string;
  readonly sha256?: string;
}

export interface AttachmentReceipt {
  readonly id: string;
}

export interface CardCounts {
  readonly total: number;
  readonly needs_me: number;
  readonly agent: number;
}

export type CardFilter = "all" | "needs_me" | "agent";

export interface CardPage {
  readonly project_id: string;
  readonly filter: CardFilter;
  readonly cards: readonly CardListItem[];
  readonly counts: CardCounts;
}

/** A failure the UI can explain: HTTP status plus the server's error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface NeedsCardRef {
  readonly id: string;
  readonly title: string;
}
export interface MergeConfirmationDelivery extends AuthorView {
  readonly id: string;
  readonly work_item_id: string;
  readonly work_item_title: string;
  readonly subject: { readonly kind: string; readonly value: string };
  readonly summary: string;
}
export interface MergeConfirmationReview extends AuthorView {
  readonly id: string;
  readonly delivery_id: string;
  readonly work_item_id: string;
  readonly work_item_title: string | null;
  readonly role_id: string | null;
  readonly kind: string;
  readonly verdict: string;
  readonly target_sha: string;
  readonly issues: readonly {
    readonly severity: string;
    readonly description: string;
    readonly must_fix: boolean;
    readonly pre_existing: boolean;
    readonly proof?: string;
  }[];
}
export interface MergeCheckView {
  readonly attempt_id: string;
  readonly completion_id: string;
  readonly status:
    | "queued"
    | "running"
    | "passed"
    | "failed"
    | "timed_out"
    | "interrupted";
  readonly scope?: {
    readonly kind: "docs_only" | "affected" | "full";
    readonly packages?: readonly string[];
  };
  readonly checks: readonly {
    readonly name: string;
    readonly status:
      | "passed"
      | "failed"
      | "timed_out"
      | "interrupted"
      | "not_run"
      | "skipped";
    readonly reason?: "docs_only";
    readonly duration_ms?: number;
  }[];
  readonly summary?: string;
  readonly log_ref?: string;
  readonly updated_at: string;
}
export interface MergeConfirmationView {
  readonly merge_noop?: boolean;
  readonly merge_gate_enabled?: boolean;
  readonly merge_gate_invalid?: boolean;
  readonly merge_check?: MergeCheckView | null;
  readonly completion: {
    readonly id: string;
    readonly work_item_id: string;
    readonly summary: string;
    readonly subject: { readonly kind: string; readonly value: string };
  } | null;
  readonly deliveries: readonly MergeConfirmationDelivery[];
  readonly reviews: readonly MergeConfirmationReview[];
  readonly known_gaps: readonly {
    readonly description: string;
    readonly followup_card_id?: string;
    readonly precondition?: string;
  }[];
}
export interface NeedsDecision extends DecisionView, AuthorView {
  readonly card_priority?: number;
  /** C-154: the PM handed this over (paused, released or delegation off). */
  readonly handed_over_from_pm?: {
    readonly at: string;
    readonly reason: string;
  } | null;
  readonly followup_notice?: string;
  readonly card_id: string | null;
  readonly affected_cards: readonly string[];
  readonly context: string;
  readonly why: string;
  readonly waited_ms: number | null;
  readonly trigger: string | null;
  readonly category: string;
  readonly assignment_id: string | null;
  readonly related_cards: readonly NeedsCardRef[];
  readonly merge_confirmation: MergeConfirmationView | null;
}
export interface NeedsAction
  extends Pick<HumanActionView, "id" | "instructions" | "expected_return">,
    AuthorView {
  readonly card_id: string | null;
  readonly why: string;
  readonly triage?: "pm_ops" | "human" | "host";
  readonly handoff?: HumanActionHandoffView;
  readonly original_request?: {
    readonly instructions: string;
    readonly why_human: string;
    readonly expected_return: string;
  };
  readonly triage_rationale?: string | null;
  readonly waited_ms: number | null;
  readonly due: string | null;
  readonly blocked_work_items: readonly string[];
  readonly completion_notice?: string;
}
export interface NeedsPage {
  readonly waiting_merge_checks_count?: number;
  readonly attention?: readonly {
    readonly kind: "review_limit_not_resumed";
    readonly card_id: string;
    readonly work_item_id: string;
    readonly decision_id: string;
    readonly resolved_at: string;
    readonly waited_ms: number;
    readonly detail: string;
  }[];
  readonly decisions: readonly NeedsDecision[];
  readonly human_actions: readonly NeedsAction[];
  /** §7.4 (C-65): merge confirmations PM Ops holds; the human may answer them. */
  readonly pm_held_merges?: readonly NeedsDecision[];
  /** §7.4 知会: delegated resolutions; never blocking. */
  readonly notices?: readonly NoticeView[];
  readonly notices_next_cursor?: string | null;
  /** C-153: who looks after lost runtimes; older servers omit it. */
  readonly incident_handling?: IncidentHandling;
  readonly incidents: readonly (AuthorView & {
    readonly id: string;
    readonly role_id: string;
    readonly runtime_state: string;
    readonly disconnected_at?: string | null;
    readonly lost_at?: string | null;
    readonly last_run?: RunView | null;
    readonly card_id: string | null;
    readonly waited_ms: number | null;
  })[];
}

export interface IncidentContact {
  readonly assignment_id: string;
  readonly name: string | null;
  /** What to type after `@` so the comment reaches this Assignment (its id). */
  readonly mention: string;
}

export interface IncidentHandling {
  readonly host_ops:
    | (IncidentContact & { readonly patrol_interval_ms: number })
    | null;
  readonly pm_office: IncidentContact | null;
  /** hc session the server registered in runtime.json; null when unknown. */
  readonly hc_session?: string | null;
}

export interface NoticeView extends AuthorView {
  readonly id: string;
  readonly kind: "merge" | "decision";
  readonly card_id: string | null;
  readonly decision_id: string;
  readonly question: string;
  readonly option: string;
  readonly resolved_by: "pm" | "system" | string;
  readonly body: string;
  readonly proxy_authority: string | null;
  readonly at: string;
  readonly read: boolean;
}

export interface NoticesPage {
  readonly notices: readonly NoticeView[];
  readonly next_cursor: string | null;
  readonly unread_count: number;
}

export interface SnapshotData {
  readonly cards: readonly CardView[];
  readonly in_progress: readonly CardView[];
  readonly in_review: readonly CardView[];
  readonly blocked: readonly {
    card_id: string;
    work_item_id: string;
    label: string;
  }[];
  readonly waiting: { human: readonly string[]; agent: readonly string[] };
  readonly recent_deliveries: readonly {
    id: string;
    work_item_id?: string;
    work_item_title?: string | null;
    submitted_at?: string | null;
    card_id: string | null;
    summary: string;
    status: string;
  }[];
}
export interface RunView {
  readonly queue_warning?: {
    readonly after_minutes: number;
    readonly waited_ms: number;
  };
  readonly queue_reason?: "concurrency_limit" | "runtime_unavailable";
  readonly queue_ahead?: number;
  readonly employee_id?: string;
  readonly launch_profile_ref?: string;
  readonly id: string;
  readonly assignment_id: string;
  readonly status: string;
  readonly kind: string;
  readonly outcome?: string | null;
  readonly model: string;
  readonly role_version: number;
  readonly agent_cli_version: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  /** When the Run was queued (its run_queued event); older servers omit it. */
  readonly queued_at?: string;
  readonly summary: string;
  /**
   * C-106: snapshotted on the Run when its session was launched; absent on
   * legacy Runs, and effort is absent when the launch did not state it.
   */
  readonly harness?: string | null;
  readonly effort?: string | null;
  /**
   * C-106: the session's context use when the Run was last observed. No
   * server collects it yet, so the column shows "—" until one does.
   */
  readonly context_usage?: ContextUsage | null;
}
export interface ContextUsage {
  /** Share of the context window in use, 0..1. */
  readonly used_ratio: number;
  /** Context window size in tokens. */
  readonly window_tokens: number;
}
export interface ExecutionAssignment extends AuthorView {
  readonly card_priority?: number;
  readonly queue_ahead?: number;
  readonly id: string;
  readonly role_id: string;
  readonly role_version: number;
  readonly status: string;
  readonly runtime_state: string;
  readonly machine_id: string;
  readonly standing_mode: string | null;
  readonly external?: boolean;
  readonly card_id: string | null;
  readonly card_status: string | null;
  readonly work_item_id: string | null;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly session_ref: string | null;
  readonly runtime_ref: {
    terminal_ref: string;
    runtime_machine: string;
  } | null;
  readonly last_mcp_activity_at: string | null;
  readonly cursors: readonly { card_id: string; acked_seq: number }[];
}
export interface ExecutionCapacity {
  readonly agents: readonly {
    machine_id: string;
    label: string;
    running: number;
    limit: number;
    queued: number;
    merge_check_slots: number;
  }[];
  readonly merge_checks: readonly {
    machine_id: string;
    running: number;
    limit: number;
    queued: number;
  }[];
  readonly merge_config_invalid: boolean;
}

export interface ExecutionData {
  readonly assignments: readonly ExecutionAssignment[];
  readonly runs: readonly RunView[];
  readonly machines: readonly { id: string; label: string; status: string }[];
}

/** C-75: one server page of an Assignment's Run history, newest first. */
export interface ExecutionRunPage {
  readonly runs: readonly RunView[];
  readonly total: number;
  /** Pass as `before` to read the next page; null on the last page. */
  readonly next_cursor: string | null;
}

export interface ActivityFilter {
  readonly card_id?: string;
  readonly role?: string;
  readonly actor?: string;
  readonly type?: string;
  readonly category?: string;
  readonly range?: string;
  readonly before?: string;
}
export interface ActivityData {
  readonly cards: readonly { id: string; title: string }[];
  readonly events: readonly {
    id: string;
    card_id: string | null;
    card_title: string | null;
    seq: number;
    type: string;
    role: string;
    created_at: string;
    payload: unknown;
    employee?: AuthorView["employee"];
    member?: MemberView | null;
    author_display?: string;
    actor: { kind: string; assignment_id?: string };
  }[];
  readonly next_before: string | null;
  readonly counts: { returned: number; matched: number };
}

export interface CardReadOptions {
  readonly limit?: number;
  readonly at?: string;
}

export interface CardUpdateInput {
  readonly title: string;
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly priority: number;
}

export interface DecisionHistoryRecord extends DecisionView {
  readonly category: string;
  readonly card_id?: string;
  readonly affected_cards: readonly string[];
  readonly decision_maker: "human" | "pm" | "system";
  readonly resolution: NonNullable<DecisionView["resolution"]> & {
    resolved_by: string;
    via: string;
    proxy_authority?: string;
  };
}
export interface TemplateDefinition {
  id: string;
  title: string;
  description: string;
  requires_repo: boolean;
  merge: "none" | "confirm" | "auto";
  require_acceptance_criteria: boolean;
  work_items: {
    key: string;
    title: string;
    kind: "produce" | "verify";
    role_id: string;
    required: boolean;
    target_work_item_key?: string;
  }[];
  primary_work_item_key: string | null;
  completion:
    | { mode: "human_mark_done" }
    | { mode: "review"; reviewer: string };
}
export interface TemplateView extends TemplateDefinition {
  version: number;
  builtin: boolean;
  status: "active" | "inactive";
}
export interface TemplateVersion extends TemplateView {
  summary: string;
  created_at: string | null;
}
export type TemplateChange =
  | { action: "add" | "update"; definition: TemplateDefinition }
  | { action: "copy"; template_id: string; new_id: string; version?: number }
  | { action: "activate" | "deactivate"; template_id: string }
  | { action: "rollback"; template_id: string; version: number };
export interface TemplateDetail {
  template: TemplateVersion;
  previous: TemplateVersion | null;
}
export interface TemplateValidation {
  valid: boolean;
  reason: string | null;
}

export interface PreferencesView {
  readonly decision_delegation?: Readonly<Record<string, boolean>>;
  /** Merge confirmations go to PM Ops; missing means the default (on). */
  readonly pm_merge_confirmation?: boolean;
  readonly auto_merge_after_minutes: number | null;
  readonly merge_gate_enabled: boolean;
  /** Lanes the human folded (true) or unfolded (false); missing = default. */
  readonly board_collapsed_lanes?: Readonly<Record<string, boolean>>;
}

export type RoleKind = "produce" | "verify" | "standing";
export type RoleWorktree = "none" | "readonly" | "write";
export type RoleAllowlists = Readonly<Record<RoleKind, readonly string[]>>;

export interface RoleSummary {
  readonly role_id: string;
  readonly display_name: string;
  readonly kind: RoleKind;
  readonly status: "active" | "inactive";
  readonly version: number;
  readonly harness: string;
  readonly launch_profile_ref: string;
}

export interface RoleListView {
  readonly project_id: string;
  readonly roles: readonly RoleSummary[];
  readonly default_roles: readonly string[];
  readonly harnesses: readonly string[];
  readonly allowlists: RoleAllowlists;
}

/** One saved role version (V9a `Role`). */
export interface RoleDefinitionView {
  readonly role_id: string;
  readonly version: number;
  readonly display_name: string;
  readonly kind: RoleKind | "work";
  readonly status?: "active" | "inactive";
  readonly instructions?: string;
  readonly core_prompt: string;
  readonly harness: string;
  readonly launch_profile_ref: string;
  readonly allowed_tools: readonly string[];
  readonly capabilities: readonly string[];
  readonly abilities: readonly string[];
  readonly worktree: RoleWorktree;
  readonly required_machine_tags: readonly string[];
}

export interface RoleDetailView {
  readonly project_id: string;
  readonly role: RoleDefinitionView & {
    readonly kind: RoleKind;
    readonly status: "active" | "inactive";
  };
  readonly previous: RoleDefinitionView | null;
  readonly allowlist: readonly string[];
  readonly allowlists: RoleAllowlists;
  readonly harnesses: readonly string[];
  /** Present for legacy roles that only have `core_prompt`. */
  readonly legacy_conversion: {
    readonly instructions: string;
    readonly warnings: readonly string[];
  } | null;
}

export interface RoleHistoryEntry extends Omit<AuthorView, "author_display"> {
  readonly version: number;
  readonly role: RoleDefinitionView;
  readonly action: string;
  readonly summary: string;
  readonly changes: readonly string[];
  readonly created_at: string | null;
  readonly actor: string | null;
  readonly author_display: string | null;
}

export interface RoleHistoryView {
  readonly project_id: string;
  readonly role_id: string;
  readonly versions: readonly RoleHistoryEntry[];
}

export interface RoleEditInput {
  readonly display_name?: string;
  readonly kind?: RoleKind;
  readonly instructions?: string;
  readonly harness?: string;
  readonly launch_profile_ref?: string;
  readonly allowed_tools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly abilities?: readonly string[];
  readonly worktree?: RoleWorktree;
  readonly required_machine_tags?: readonly string[];
}

export interface RoleCopyInput {
  readonly role_id: string;
  readonly display_name?: string;
  readonly source:
    | {
        readonly kind: "default";
        readonly role_id: string;
        readonly harness: string;
        readonly launch_profile_ref: string;
      }
    | {
        readonly kind: "project";
        readonly project_id?: string;
        readonly role_id: string;
        readonly version?: number;
      };
}

export interface CardiganClient {
  templates(projectId: string): Promise<{ templates: TemplateView[] }>;
  template(projectId: string, id: string): Promise<TemplateDetail>;
  templateHistory(
    projectId: string,
    id: string,
  ): Promise<{ versions: TemplateVersion[] }>;
  validateTemplate(
    projectId: string,
    change: TemplateChange,
  ): Promise<TemplateValidation>;
  manageTemplate(
    projectId: string,
    change: TemplateChange,
    idempotencyKey: string,
  ): Promise<TemplateView>;
  markCardDone(
    projectId: string,
    cardId: string,
    result: string,
    attachments: string[],
    idempotencyKey: string,
  ): Promise<void>;
  roles(projectId: string): Promise<RoleListView>;
  role(projectId: string, roleId: string): Promise<RoleDetailView>;
  roleHistory(projectId: string, roleId: string): Promise<RoleHistoryView>;
  copyRole(
    projectId: string,
    input: RoleCopyInput,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView>;
  updateRole(
    projectId: string,
    roleId: string,
    patch: RoleEditInput,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView>;
  setRoleActive(
    projectId: string,
    roleId: string,
    active: boolean,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView>;
  rollbackRole(
    projectId: string,
    roleId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView>;
  decisionHistory(
    projectId: string,
    filters: Readonly<Record<string, string>>,
  ): Promise<{ decisions: readonly DecisionHistoryRecord[] }>;
  setDelegation(
    projectId: string,
    category: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setPmMergeConfirmation(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setBoardLane(
    projectId: string,
    lane: string,
    collapsed: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  markNoticesRead(
    projectId: string,
    noticeIds: readonly string[],
  ): Promise<void>;
  preferences(projectId: string): Promise<PreferencesView>;
  setPreferences(
    projectId: string,
    minutes: number | null,
    idempotencyKey: string,
  ): Promise<void>;
  updateCard(
    projectId: string,
    cardId: string,
    input: CardUpdateInput,
    idempotencyKey?: string,
  ): Promise<void>;
  cancelCard(
    projectId: string,
    cardId: string,
    reason: string,
    idempotencyKey?: string,
  ): Promise<void>;
  supersedeCard(
    projectId: string,
    cardId: string,
    supersededBy: string,
    idempotencyKey?: string,
  ): Promise<void>;
  setCardSensitive(
    projectId: string,
    cardId: string,
    sensitive: boolean,
    idempotencyKey?: string,
  ): Promise<SensitiveResult>;
  subscribe(projectId: string, callbacks: StreamCallbacks): () => void;
  activity(projectId: string, filters: ActivityFilter): Promise<ActivityData>;
  snapshot(projectId: string): Promise<SnapshotData>;
  executionCapacity(projectId: string): Promise<ExecutionCapacity>;
  setRunLimit(
    projectId: string,
    machineId: string,
    limit: number,
    idempotencyKey: string,
  ): Promise<void>;
  execution(projectId: string): Promise<ExecutionData>;
  executionRuns(
    projectId: string,
    assignmentId: string,
    before?: string,
  ): Promise<ExecutionRunPage>;
  needsYou(projectId: string): Promise<NeedsPage>;
  notices(projectId: string, before: string): Promise<NoticesPage>;
  recheckMerge(
    projectId: string,
    cardId: string,
    completionId: string,
    idempotencyKey?: string,
  ): Promise<void>;
  recordDecision(
    projectId: string,
    id: string,
    option: string,
    quote: string,
    idempotencyKey?: string,
    delegateFuture?: boolean,
  ): Promise<void>;
  decisionComment(
    projectId: string,
    id: string,
    action: "request_information" | "explain",
    body: string,
    idempotencyKey?: string,
  ): Promise<void>;
  completeAction(
    projectId: string,
    id: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<void>;
  session(): Promise<SessionInfo>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  projects(): Promise<readonly ProjectSummary[]>;
  cards(projectId: string, filter: CardFilter): Promise<CardPage>;
  card(
    projectId: string,
    cardId: string,
    options?: CardReadOptions,
  ): Promise<CardDetail>;
  addComment(
    projectId: string,
    cardId: string,
    input: CommentInput,
    idempotencyKey?: string,
  ): Promise<PostedComment>;
  uploadAttachment(
    projectId: string,
    cardId: string,
    input: UploadAttachmentInput,
    idempotencyKey?: string,
  ): Promise<AttachmentReceipt>;
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class HttpCardiganClient implements CardiganClient {
  /**
   * `fetchImpl` is injected by tests; production uses the global `fetch`, which
   * sends the cookie and the `Origin` header without any help from this code.
   */
  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly streamFactory: StreamFactory = browserStream,
  ) {}

  subscribe(projectId: string, callbacks: StreamCallbacks): () => void {
    return subscribeProject(projectId, callbacks, this.streamFactory);
  }
  async session(): Promise<SessionInfo> {
    return this.request<SessionInfo>("/api/session");
  }

  async login(password: string): Promise<void> {
    await this.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async logout(): Promise<void> {
    await this.request("/api/logout", { method: "POST", body: "{}" });
  }

  async projects(): Promise<readonly ProjectSummary[]> {
    const body = await this.request<{ projects: ProjectSummary[] }>(
      "/api/projects",
    );
    return body.projects;
  }

  async cards(projectId: string, filter: CardFilter): Promise<CardPage> {
    return this.request<CardPage>(
      `/api/projects/${encodeURIComponent(projectId)}/cards?filter=${filter}`,
    );
  }

  async card(
    projectId: string,
    cardId: string,
    options: CardReadOptions = {},
  ): Promise<CardDetail> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.at) params.set("at", options.at);
    const query = params.size ? `?${params}` : "";
    return this.request<CardDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}${query}`,
    );
  }

  async addComment(
    projectId: string,
    cardId: string,
    input: CommentInput,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<PostedComment> {
    return this.request<PostedComment>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/comments`,
      { method: "POST", body: JSON.stringify(input), idempotencyKey },
    );
  }

  async uploadAttachment(
    projectId: string,
    cardId: string,
    input: UploadAttachmentInput,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<AttachmentReceipt> {
    return this.request<AttachmentReceipt>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/attachments`,
      { method: "POST", body: JSON.stringify(input), idempotencyKey },
    );
  }

  activity(projectId: string, filters: ActivityFilter): Promise<ActivityData> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value) query.set(key, value);
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/activity?${query}`,
    );
  }
  snapshot(projectId: string): Promise<SnapshotData> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/snapshot`,
    );
  }
  executionCapacity(projectId: string): Promise<ExecutionCapacity> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/execution/capacity`,
    );
  }
  async setRunLimit(
    projectId: string,
    machineId: string,
    limit: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "execution/capacity",
      { machine_id: machineId, limit },
      idempotencyKey,
    );
  }
  execution(projectId: string): Promise<ExecutionData> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/execution`,
    );
  }
  executionRuns(
    projectId: string,
    assignmentId: string,
    before?: string,
  ): Promise<ExecutionRunPage> {
    const query = before ? `?${new URLSearchParams({ before })}` : "";
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/execution/assignments/${encodeURIComponent(assignmentId)}/runs${query}`,
    );
  }
  decisionHistory(
    projectId: string,
    filters: Readonly<Record<string, string>>,
  ): Promise<{ decisions: readonly DecisionHistoryRecord[] }> {
    const query = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v),
    );
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/decision-history?${query}`,
    );
  }
  async setDelegation(
    projectId: string,
    category: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { decision_delegation: { [category]: enabled } },
      idempotencyKey,
    );
  }
  templates(projectId: string): Promise<{ templates: TemplateView[] }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/card-templates`,
    );
  }
  template(projectId: string, id: string): Promise<TemplateDetail> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/card-templates/${encodeURIComponent(id)}`,
    );
  }
  templateHistory(
    projectId: string,
    id: string,
  ): Promise<{ versions: TemplateVersion[] }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/card-templates/${encodeURIComponent(id)}/history`,
    );
  }
  validateTemplate(
    projectId: string,
    change: TemplateChange,
  ): Promise<TemplateValidation> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/card-templates/validate`,
      { method: "POST", body: JSON.stringify(change) },
    );
  }
  async manageTemplate(
    projectId: string,
    change: TemplateChange,
    idempotencyKey: string,
  ): Promise<TemplateView> {
    return (await this.write(
      projectId,
      "card-templates",
      change,
      idempotencyKey,
    )) as TemplateView;
  }
  async markCardDone(
    projectId: string,
    cardId: string,
    result: string,
    attachments: string[],
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/mark-done`,
      { result, attachments },
      idempotencyKey,
    );
  }
  async setPmMergeConfirmation(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { pm_merge_confirmation: enabled },
      idempotencyKey,
    );
  }
  async setBoardLane(
    projectId: string,
    lane: string,
    collapsed: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { board_collapsed_lanes: { [lane]: collapsed } },
      idempotencyKey,
    );
  }
  async markNoticesRead(
    projectId: string,
    noticeIds: readonly string[],
  ): Promise<void> {
    // Marking read is idempotent in the domain; a fresh key per click is safe.
    await this.write(
      projectId,
      "notices/read",
      { notice_ids: noticeIds },
      crypto.randomUUID(),
    );
  }
  preferences(projectId: string): Promise<PreferencesView> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/preferences`,
    );
  }
  async setPreferences(
    projectId: string,
    minutes: number | null,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { auto_merge_after_minutes: minutes },
      idempotencyKey,
    );
  }
  roles(projectId: string): Promise<RoleListView> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/roles`);
  }
  role(projectId: string, roleId: string): Promise<RoleDetailView> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}`,
    );
  }
  roleHistory(projectId: string, roleId: string): Promise<RoleHistoryView> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/history`,
    );
  }
  copyRole(
    projectId: string,
    input: RoleCopyInput,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView> {
    return this.write(
      projectId,
      "roles/copy",
      input,
      idempotencyKey,
    ) as Promise<RoleDefinitionView>;
  }
  updateRole(
    projectId: string,
    roleId: string,
    patch: RoleEditInput,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView> {
    return this.write(
      projectId,
      `roles/${encodeURIComponent(roleId)}/update`,
      patch,
      idempotencyKey,
    ) as Promise<RoleDefinitionView>;
  }
  setRoleActive(
    projectId: string,
    roleId: string,
    active: boolean,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView> {
    return this.write(
      projectId,
      `roles/${encodeURIComponent(roleId)}/${active ? "activate" : "deactivate"}`,
      {},
      idempotencyKey,
    ) as Promise<RoleDefinitionView>;
  }
  rollbackRole(
    projectId: string,
    roleId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<RoleDefinitionView> {
    return this.write(
      projectId,
      `roles/${encodeURIComponent(roleId)}/rollback`,
      { version },
      idempotencyKey,
    ) as Promise<RoleDefinitionView>;
  }
  needsYou(projectId: string): Promise<NeedsPage> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/needs-you`,
    );
  }
  notices(projectId: string, before: string): Promise<NoticesPage> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/notices?${new URLSearchParams({ before })}`,
    );
  }
  async recheckMerge(
    projectId: string,
    cardId: string,
    completionId: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/recheck-merge`,
      { completion_id: completionId },
      idempotencyKey,
    );
  }
  async recordDecision(
    projectId: string,
    id: string,
    option: string,
    quote: string,
    idempotencyKey: string = crypto.randomUUID(),
    delegateFuture = false,
  ): Promise<void> {
    await this.write(
      projectId,
      `decisions/${encodeURIComponent(id)}/resolve`,
      {
        option,
        raw_quote: quote,
        ...(delegateFuture ? { delegate_future: true } : {}),
      },
      idempotencyKey,
    );
  }
  async decisionComment(
    projectId: string,
    id: string,
    action: "request_information" | "explain",
    body: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `decisions/${encodeURIComponent(id)}/comments`,
      { action, ...(body.trim() ? { body } : {}) },
      idempotencyKey,
    );
  }
  async completeAction(
    projectId: string,
    id: string,
    text: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `human-actions/${encodeURIComponent(id)}/complete`,
      { text },
      idempotencyKey,
    );
  }
  private write(
    projectId: string,
    rest: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/${rest}`,
      { method: "POST", body: JSON.stringify(body), idempotencyKey },
    );
  }

  async updateCard(
    projectId: string,
    cardId: string,
    input: CardUpdateInput,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/update`,
      input,
      idempotencyKey,
    );
  }
  async cancelCard(
    projectId: string,
    cardId: string,
    reason: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/cancel`,
      { reason },
      idempotencyKey,
    );
  }
  async supersedeCard(
    projectId: string,
    cardId: string,
    supersededBy: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/supersede`,
      { superseded_by: supersededBy },
      idempotencyKey,
    );
  }
  async setCardSensitive(
    projectId: string,
    cardId: string,
    sensitive: boolean,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<SensitiveResult> {
    const output = (await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/sensitive`,
      { sensitive },
      idempotencyKey,
    )) as Partial<SensitiveResult> | null;
    // C-72: treat a reply without the flag as a change (pre-C-72 behaviour).
    return {
      changed: output?.changed !== false,
      auto_merge_due_at: output?.auto_merge_due_at ?? null,
    };
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: string; idempotencyKey?: string } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const response = await this.fetchImpl(path, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": init.idempotencyKey }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (!response.ok) {
      throw await toApiError(response, method, path);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

async function toApiError(
  response: Response,
  method: string,
  path: string,
): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A non-JSON error (a proxy, a crash) still has to surface as a failure.
  }
  const code = body.error?.code ?? `http_${response.status}`;
  const message =
    body.error?.message ?? `${method} ${path} 失败（${response.status}）`;
  return new ApiError(response.status, code, message);
}

/** Human-readable Chinese explanation of a failed request. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // The login endpoint answers 401 for a wrong password; every other 401 is a
    // session that expired or was revoked by a password change.
    if (error.code === "invalid_credentials") return "密码不对。";
    if (error.status === 401) return "会话已失效，请重新登录。";
    if (error.status === 429) return "尝试次数太多，请稍后再试。";
    if (error.status === 403) return "请求被拒绝（来源校验未通过）。";
    return `请求失败：${error.message}`;
  }
  if (error instanceof TypeError) {
    return "连不上 Workbench 服务，确认 cardigan server 还在运行。";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Only transport failures and 5xx responses leave a write's outcome uncertain. */
export function describeWriteError(
  error: unknown,
  uncertainMessage = "操作可能已经成功，保留原内容重试不会重复提交。",
): string {
  const interrupted =
    (error instanceof Error || error instanceof DOMException) &&
    ["TimeoutError", "AbortError", "NetworkError"].includes(error.name);
  const uncertain =
    error instanceof ApiError
      ? error.status >= 500 && error.status < 600
      : error instanceof TypeError || interrupted;
  let reason = describeError(error);
  if (interrupted) {
    reason = error.name === "TimeoutError" ? "请求超时。" : "请求连接已中断。";
  } else if (
    error instanceof ApiError &&
    error.status !== 401 &&
    error.status !== 403 &&
    error.status !== 429 &&
    !/\p{Script=Han}/u.test(error.message)
  ) {
    const reasons: Record<string, string> = {
      validation_failed: "填写的内容不符合要求，请检查后重试。",
      illegal_transition: "当前状态不允许此操作，请刷新后确认。",
      invariant_violation: "此操作不符合业务约束，请刷新后确认。",
      stale_target: "操作目标已有新版本，请刷新后确认。",
      not_found: "操作目标不存在，请核对后重试。",
      idempotency_conflict:
        "上一次请求已成功，但内容与本次不同，请核对后再提交。",
    };
    reason =
      reasons[error.code] ??
      (uncertain ? "服务暂时异常。" : "请求被拒绝，请检查填写内容和当前状态。");
  }
  return uncertain ? `${reason} ${uncertainMessage}` : reason;
}
