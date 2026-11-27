import type { CardHold, DispatchOrder, ReviewImpact } from "@cardigan/domain";
import { needsAges } from "./needs-age.js";
import type { RunPresence } from "./run-presence.js";
import { clearSharedReads, sharePendingRead } from "./shared-read.js";
import type { VideoMeasurements } from "./video-probe.js";
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
  defaultRetryPolicy,
  isReadOverload,
  isRetryableRequest,
  READ_OVERLOAD_CODES,
  type RetryPolicy,
  SERVICE_UPDATING_STATUSES,
} from "./service-retry.js";
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

export interface BuildInfo {
  readonly sha: string | null;
  readonly built_at: string | null;
  readonly development: boolean;
}

export interface SessionInfo {
  readonly authenticated: boolean;
  readonly password_configured: boolean;
  /** Non-authorizing, session-specific namespace for overlapping tab reads. */
  readonly read_scope?: string;
  readonly build?: BuildInfo;
  /** Host attachment upload limit in bytes (C-616); only when authenticated. */
  readonly attachment_max_bytes?: number;
  /** C-683: host video limit and chunk size of resumable uploads. */
  readonly video_max_bytes?: number;
  readonly video_chunk_bytes?: number;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  /** C-674: display code full numbers are written with (`SEN-C-34`). */
  readonly code?: string | null;
}

export interface WaitingOnItem {
  readonly review_phase?: import("@cardigan/domain").WaitingOnItem["review_phase"];
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

export type RiskTag = "security" | "permission" | "numeric_rule";

/** The card view the API returns; `status`, `why` and `next_owners` are derived. */
export interface MergeStageView {
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
  readonly protecting_files?: readonly string[];
  readonly protecting_card_held?: boolean;
  readonly protecting_expires_at?: string;
  readonly held_since?: string;
  readonly release_at?: string;
  readonly card_check?: MergeCheckView;
  readonly batch_check?: MergeCheckView;
  readonly color?: number;
}
export interface MergeBatchView {
  readonly culprit?: string;
  readonly published_prefix?: string;
  readonly id: string;
  readonly status: string;
  readonly members: readonly {
    card_id: string;
    completion_id: string;
    merge_sha: string;
    tree_sha: string;
  }[];
  readonly base_sha: string;
  readonly final_sha: string;
  readonly final_tree_sha: string;
  readonly solo: boolean;
  readonly check?: MergeCheckView;
}
export interface StoryChildChoice {
  action: "cancel" | "detach";
  ids: readonly string[];
}
export interface CreatedCard {
  readonly id: string;
  /** Older servers omit it; files then cannot be attached. */
  readonly entry_id?: string | null;
}
export interface CreateCardInput {
  title: string;
  goal: string;
  template_id: string;
  acceptance_criteria?: string[];
  parent_card_id?: string;
  state_and_save?: import("@cardigan/domain").UiStateAndSave;
}
export interface CardView {
  readonly parent_card_id?: string;
  readonly story?: import("@cardigan/domain").StoryState & {
    discussion_rounds?: number;
  };
  readonly story_progress?: {
    children: { id: string; title: string; status: CardStatus }[];
    counts: Record<CardStatus, number>;
    finished: number;
    total: number;
  };
  readonly merge_solo?: boolean;
  readonly merge_stage?: MergeStageView;
  readonly depends_on_cards?: readonly string[];
  readonly wait_for_dependencies?: boolean;
  readonly early_start?: {
    readonly reason: string;
    readonly set_by: string;
    readonly set_at: string;
  };
  readonly dependency?: {
    readonly predecessors: readonly DependencyCard[];
    readonly successors: readonly DependencyCard[];
    readonly waiting_on: readonly string[];
    readonly critical_path_length: number;
    /** C-487: detail reads only; every transitive prerequisite and dependent. */
    readonly graph?: DependencyGraph;
  };
  readonly template?: string;
  readonly template_version?: number;
  readonly hold?: CardHold;
  readonly prechecks?: readonly AuthorPrecheck[];
  readonly merge_check_blockers?: readonly MergeCheckBlocker[];
  /** C-567: present only while a precheck or merge check is queued/running. */
  readonly checking?: CardChecking;
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly status: CardStatus;
  readonly resolution?: "done" | "superseded" | "duplicate" | "wontdo";
  readonly superseded_by?: string;
  /** C-65: human-only flag; its merge confirmation always goes to the human. */
  readonly sensitive?: boolean;
  /** C-188: PM-set risk tags; the Web only displays them (C-197). */
  readonly risk_tags?: readonly RiskTag[];
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

export interface CardChecking {
  readonly precheck?: {
    readonly attempt_ids: readonly string[];
    /** Blocked work items that only wait for one of these attempts. */
    readonly waiting_items: readonly string[];
    /** Other cards whose precheck is waited for; their events refresh this card. */
    readonly cards?: readonly string[];
  };
  readonly merge_check?: {
    readonly attempt_id: string;
    readonly status: "queued" | "running";
  };
}

export interface DependencyCard {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly resolution?: string;
  readonly satisfied: boolean;
}
export interface DependencyGraph {
  readonly nodes: readonly DependencyCard[];
  /** `from` must finish before `to`. */
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

/** A list row: the card plus the fields the list filters and columns need. */
export interface CardListItem
  extends Omit<
    CardView,
    | "goal"
    | "acceptance_criteria"
    | "source"
    | "repo"
    | "base_branch"
    | "created_at"
    | "related_cards"
  > {
  readonly template_info?: CardTemplateInfo | null;
  /** Legacy full-list responses may include prose; the board requests summaries. */
  readonly repo?: string;
  readonly base_branch?: string;
  readonly created_at?: string;
  readonly related_cards?: readonly string[];
  readonly goal?: string;
  readonly acceptance_criteria?: readonly string[];
  readonly source?: CardView["source"];
  readonly queued_runs?: readonly {
    readonly run_id: string;
    readonly assignment_id: string;
    readonly ahead: number;
  }[];
  readonly produce_owners?: readonly AuthorView[];
  /** C-531: `run_presence` is this person's state for this card; older servers omit it. */
  readonly participants?: readonly (AuthorView & {
    readonly run_presence?: RunPresence;
  })[];
  readonly work_items?: readonly Pick<
    WorkItemView,
    "id" | "title" | "status"
  >[];
  readonly attachment_count?: number;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly updated_at: string;
  readonly roles: readonly string[];
}

/** Only the metadata needed to identify a card's bound template. */
export interface CardTemplateInfo {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly builtin: boolean;
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
  /**
   * C-674: a full number (`SEN-C-34`) names its project; `id` is the text as
   * written and `local_id` the project-scoped number the link points at.
   */
  readonly project_id?: string;
  readonly local_id?: string;
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
  readonly verification_activity?: {
    readonly status: string;
    readonly label: string;
    readonly delivery_id?: string;
  };
  readonly manual_assign?: boolean;
  readonly id: string;
  readonly card_id: string;
  readonly title: string;
  readonly kind: "produce" | "verify";
  /** The card template slot this item fills, if any. */
  readonly template_key?: string;
  /** C-778: a retired item points at the one that took its place. */
  readonly replaced_by_work_item_id?: string;
  readonly role_id: string;
  readonly required: boolean;
  readonly status: string;
  readonly depends_on: readonly string[];
  readonly completion_criteria: readonly string[];
  readonly assignment_id?: string;
  /** C-531: the unreleased owner and their state for this work item only. */
  readonly assignee?: AuthorView;
  readonly run_presence?: RunPresence;
  readonly target_work_item_id?: string;
  /** MC-2: scheduling constraints declared on the work item itself. */
  readonly requirements?: MachineRequirements;
  /** MC-5: the newest placement outcome; older servers omit it. */
  readonly machine_selection?: MachineSelection;
}

export interface PrimaryReplacementInput {
  readonly replacement_work_item_id: string;
  /** Expected card and slot; the server refuses a stale view. */
  readonly card_id: string;
  readonly template_key: string;
  readonly reason: string;
}

export interface MachineRequirements {
  readonly os?: string;
  readonly arch?: string;
  readonly capabilities?: readonly string[];
  readonly tags?: readonly string[];
}

export interface MachineSelectionCandidate {
  readonly machine_id: string;
  readonly affinity: boolean;
  readonly control_host: boolean;
  readonly limit: number | null;
  readonly occupied: number | null;
  readonly pending_assignments?: number;
  readonly remaining_ratio: number | null;
  readonly preference_rank: number | null;
  /** Resource slots at selection time; older events omit them. */
  readonly resources?: readonly {
    readonly key: string;
    readonly limit: number;
    readonly occupied: number;
  }[];
  /** C-716: this project's own ceilings on the machine at selection time. */
  readonly project_limit?: {
    readonly limit: number;
    readonly occupied: number;
  };
  readonly project_resources?: readonly {
    readonly key: string;
    readonly limit: number;
    readonly occupied: number;
  }[];
  /** C-716: limits already full on this machine at selection time. */
  readonly full?: readonly string[];
}

export type MachineSelection =
  | {
      readonly status: "deferred";
      readonly at: string;
      readonly reason: string;
    }
  | {
      /** `assigned`: placed without a selection audit; the source is unknown. */
      readonly status: "selected" | "assigned";
      readonly at: string;
      readonly machine_id: string;
      readonly assignment_id?: string;
      readonly candidates?: readonly MachineSelectionCandidate[];
      /** C-716: every eligible machine was full; the Run queues on these limits. */
      readonly queued_on?: readonly string[];
      readonly excluded?: readonly {
        readonly machine_id: string;
        readonly reasons: readonly string[];
      }[];
    };

export interface TimelineEntryView extends AuthorView {
  readonly merge_check_blocker?: MergeCheckBlocker;
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

export interface MergeCheckBlocker {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly started_at: string;
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
  /** When the delivery was submitted (from its event); absent on old servers. */
  readonly submitted_at?: string;
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
  readonly followup_card_id?: string;
  readonly issues?: readonly {
    impact?: ReviewImpact;
    severity: string;
    description: string;
    must_fix: boolean;
    pre_existing: boolean;
    proof?: string;
  }[];
  readonly recheck_required?: boolean;
  /** When the review was submitted (from its event); absent on old servers. */
  readonly submitted_at?: string;
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

export interface SuggestionProgressView {
  readonly count: number;
  readonly token: string;
  readonly entries: readonly {
    readonly id: string;
    readonly card_id?: string;
    readonly at: string;
    readonly author_display: string;
    readonly summary: string;
  }[];
}
export interface DecisionSuggestionView {
  readonly version: number;
  readonly option: string;
  readonly rationale: string;
  readonly return_reason?: string;
  readonly by: string;
  readonly at: string;
  readonly stale: boolean;
  readonly progress?: SuggestionProgressView;
}
/** C-202: plain-language summary shown first on a decision. */
export interface PlainSummaryView {
  readonly changed: string;
  readonly impact: string;
  readonly risk: string;
}
export interface SourceMergeSuggestionView {
  readonly card_id: string;
  readonly source_decision_id: string;
  readonly version: number;
  readonly rationale: string;
  readonly by: string;
  readonly at: string;
  readonly stale: boolean;
  readonly confirmed?: {
    readonly by: "human";
    readonly at: string;
    readonly event_id: string;
  };
}
export interface DecisionView {
  readonly source_unrelated_suggestion?: SourceMergeSuggestionView;
  readonly human_required_reason?: string;
  readonly delegation_authority?: string;
  readonly card_id?: string | null;
  readonly affected_cards?: readonly string[];
  /** Current summaries of the existing cards explicitly affected by this decision. */
  readonly affected_card_views?: CardRelations["cards"];
  readonly auto_merge?: {
    readonly minutes: number;
    readonly due_at: string;
    /** C-154: time left when the view was read (countdown may restart). */
    readonly remaining_ms?: number;
  } | null;
  readonly trigger?: string | null;
  /** Independent review limits use their dedicated authorization setting. */
  readonly independent_review_limit?: { readonly max_delegated_raises: number };
  readonly id: string;
  readonly question: string;
  readonly status: string;
  readonly snooze?: {
    readonly reason: string;
    readonly until: string;
    readonly at: string;
    readonly by: string;
  };
  readonly blocking: boolean;
  readonly decider: string;
  readonly decider_view?: AuthorView | null;
  readonly options: readonly {
    readonly key: string;
    readonly description: string;
    readonly impact: string;
  }[];
  readonly recommended: string;
  /** C-192: the raiser's suggestion; `stale` disables one-click handling. */
  readonly suggestion?: DecisionSuggestionView;
  /** C-202: absent on older decisions, which show `context` as before. */
  readonly plain_summary?: PlainSummaryView;
  readonly context?: string;
  /** Card attachments the requester referenced, in display order (§6). */
  readonly attachments?: readonly AttachmentView[];
  /** C-809: attachments left out at the per-decision limit; absent when none. */
  readonly attachments_omitted?: number;
  /** C-809: the card's acceptance criteria when a completion review was raised. */
  readonly acceptance_criteria_snapshot?: readonly string[];
  /** Presentation only; each source question still has its own answer. */
  readonly grouped_decisions?: readonly (DecisionView &
    AuthorView & { readonly approval_target?: string })[];
  readonly resolution?: AuthorView & {
    option: string;
    rationale: string;
    raw_quote: string;
    at: string;
  };
}

export interface HumanActionHandoffView {
  readonly title: string;
  /** C-212: one line saying what to do; older rewrites omit it. */
  readonly todo?: string;
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
  readonly card_id?: string;
  /** C-760: absent on older servers; legacy holds may lack a prerequisite. */
  readonly blocks_merge?: boolean;
  readonly prerequisite?: MergePrerequisite;
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
  /** Small server-rendered preview for inline bitmaps; null otherwise. */
  readonly thumbnail_path: string | null;
  /** Lightbox image for inline bitmaps; older servers omit it. */
  readonly preview_path?: string | null;
  /** C-615: the `attachment-new-N` of its comment this file fills. */
  readonly ref_slot?: number;
  /** C-683: videos only — what the uploader measured, and its cover frame. */
  readonly video?: VideoMeasurements;
  readonly poster_path?: string;
}

/** C-683: a resumable upload, as the server reports it. */
export interface UploadStatus {
  readonly upload_id: string;
  readonly size: number;
  readonly received: number;
  readonly chunk_bytes: number;
  readonly complete: boolean;
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

export type CardPanel = "work" | "records" | "attachments" | "timeline";
export interface CardDetail {
  readonly overview?: {
    work_count: number;
    completed_work_count: number;
    verifiers: readonly (Pick<
      WorkItemView,
      "id" | "role_id" | "completion_criteria"
    > &
      Partial<Pick<WorkItemView, "title">> &
      Pick<ReviewMatrixRow, "verdict">)[];
    attachment_count: number;
    completion_id?: string;
    waiting_delivery: readonly string[];
    conclusion_reviews: readonly {
      id: string;
      verdict: string;
      delivery_id: string;
      work_title?: string;
      delivery_kind?: string;
      delivery_status?: string;
    }[];
  };
  readonly work_delivery_links?: readonly Pick<
    DeliveryView,
    "id" | "work_item_id" | "status"
  >[];
  readonly timeline_next_cursor?: string | null;
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
  /**
   * C-615: other cards' attachments this page's bodies mention by number and
   * the reader may see; anything else stays plain text.
   */
  readonly referenced_attachments?: readonly ReferencedAttachment[];
  readonly relations: CardRelations;
  readonly counts: {
    readonly timeline: number;
    readonly deliveries: number;
    readonly reviews: number;
    readonly open_decisions: number;
  };
}

export interface CommentInput {
  readonly story_discussion?: import("@cardigan/domain").StoryReply;
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
  /** Canonical padded base64; or `upload_id` of a complete upload (video). */
  readonly file?: string;
  readonly upload_id?: string;
  /** C-683: what the browser measured, and its cover frame (base64 JPEG). */
  readonly video?: VideoMeasurements;
  readonly poster?: string;
  readonly original_filename?: string;
  readonly note?: string;
  readonly mime: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to:
    | { readonly kind: "timeline_entry"; readonly id: string }
    | { readonly kind: "delivery"; readonly id: string };
  readonly basis?: string;
  readonly sha256?: string;
  /** C-615: the `attachment-new-N` of the comment this file fills. */
  readonly ref_slot?: number;
}

/** An attachment of another card, as `CardDetail.referenced_attachments`. */
export type ReferencedAttachment = AttachmentView & {
  readonly card_id: string;
};

export interface AttachmentRefsResponse {
  readonly attachments: readonly ReferencedAttachment[];
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
  readonly snapshot_version?: string;
  readonly read_scope?: string;
  readonly server_filtered?: boolean;
  readonly total_filtered?: number;
  readonly page?: number;
  readonly page_size?: number;
  readonly roles?: readonly string[];
  /** C-816: card types used in the project, named like TemplateMarker. */
  readonly templates?: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly lanes?: Readonly<
    Record<
      string,
      {
        readonly total: number;
        readonly held_total?: number;
        readonly next_cursor: string | null;
      }
    >
  >;
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
    /**
     * C-250: an earlier automatic retry of this same request lost its reply,
     * so the write may already have taken effect whatever this status says.
     */
    readonly outcomeUncertain = false,
    /** The server's `error.details`, when it sent any (e.g. the invalid field). */
    readonly details?: unknown,
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
  readonly followup_card_id?: string;
  readonly issues: readonly {
    readonly impact?: ReviewImpact;
    readonly severity: string;
    readonly description: string;
    readonly must_fix: boolean;
    readonly pre_existing: boolean;
    readonly proof?: string;
  }[];
}
export interface MergeCheckView {
  readonly level?: "single" | "card" | "batch";
  readonly queue_wait?: { readonly reason: string; readonly queued_at: string };
  readonly base_sha?: string;
  readonly executor?: {
    readonly name: string;
    readonly type: "ssh" | "github";
  };
  readonly attempt_id: string;
  readonly completion_id: string;
  readonly status:
    | "queued"
    | "running"
    | "passed"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "executor_unreachable";
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
    readonly reason?: "docs_only" | "card_tier";
    readonly duration_ms?: number;
  }[];
  readonly summary?: string;
  readonly log_ref?: string;
  readonly updated_at: string;
}
export interface PreMergeCheckView {
  readonly label: string;
  readonly status: "pending" | "passed" | "failed";
  /** The recorded conclusion was for an older version; shown as pending. */
  readonly stale?: boolean;
  readonly note: string | null;
  readonly updated_at: string;
}
/** C-760: credential or external-account preparation that holds a merge. */
export type MergePrerequisite = "credential" | "external_account";
export type MergeBlockingInput =
  | {
      readonly blocks_merge: true;
      readonly prerequisite: MergePrerequisite;
      readonly reason: string;
    }
  | { readonly blocks_merge: false; readonly reason: string };
export interface MergeConfirmationView {
  /** C-760: open actions still holding this merge; older servers omit it. */
  readonly blocking_human_actions?: readonly {
    readonly id: string;
    readonly title: string;
  }[];
  readonly decision_evidence_required?: readonly {
    readonly decision_id: string;
    readonly option: string | null;
  }[];
  /** C-264: reasons returned by the domain confirmation gate. */
  readonly blockers?: readonly string[];
  /** C-768: optional verifiers still open; confirming merge waives them. */
  readonly optional_pending?: readonly {
    readonly id: string;
    readonly title: string;
  }[];
  /** C-160: checks to finish before the human confirms; empty when none. */
  readonly pre_merge_checks?: readonly PreMergeCheckView[];
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
  readonly terminal?: import("@cardigan/domain").ActionCommand;
  readonly requires_loss_conclusion?: boolean;
  readonly last_loss_observation?: {
    readonly conclusion: "unconfirmed";
    readonly at: string;
  };
  readonly helper_checks?: import("@cardigan/domain").HumanAction["helper_checks"];
  readonly card_id: string | null;
  readonly why: string;
  readonly triage?: "pm_ops" | "human" | "host";
  /** C-212: host actions only; external operators never wake host_ops. */
  readonly host_operator?: "external" | "host_ops";
  /** C-742: `operator` actions belong to 张良; absent on older servers means owner. */
  readonly executor?: "owner" | "operator";
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
  /** C-760: true while the action holds its card's merge. */
  readonly blocks_merge?: boolean;
  readonly prerequisite?: MergePrerequisite;
  readonly completion_notice?: string;
  /** C-179: a pre-merge check passed while this action still holds the merge. */
  readonly pre_merge_check_reminder?: {
    readonly label: string;
    readonly text: string;
    readonly at: string;
  };
}
export interface NeedsLaterItem {
  readonly kind: "decision" | "human_action";
  readonly id: string;
  readonly card_id: string | null;
  readonly title: string;
  readonly triage?: "human" | "host";
  readonly waiting_for: string;
}
/** C-503: a story's current proposal waiting for the human's confirmation. */
export interface NeedsStoryProposal {
  readonly card_id: string;
  readonly card_title: string;
  readonly version: number;
  readonly entry_id: string;
  readonly submitted_at: string;
  readonly waited_ms: number | null;
  readonly children: readonly {
    readonly title: string;
    readonly template_id: string;
    readonly owner_role: string;
  }[];
}
/** C-750: a finished card waiting for the owner to mark it done. */
export interface NeedsCardToClose {
  readonly card_id: string;
  readonly card_title: string;
  readonly template: string;
  readonly required_work_items: number;
  readonly close_request: {
    readonly reason: string;
    readonly set_by: string;
    readonly set_at: string;
  } | null;
  readonly since: string | null;
  readonly waited_ms: number | null;
}
export interface StoryConfirmation {
  readonly card_id: string;
  readonly version: number;
  readonly card_ids: readonly string[];
  readonly replayed: boolean;
}
export interface NeedsPage {
  /** C-503: older servers omit it. */
  readonly story_proposals?: readonly NeedsStoryProposal[];
  /** C-750: older servers omit it. */
  readonly cards_to_close?: readonly NeedsCardToClose[];
  readonly waiting_merge_checks_count?: number;
  /** C-171: the confirmations the waiting summary counts (queued or running). */
  readonly waiting_merge_check_items?: readonly {
    readonly decision_id: string;
    readonly card_id: string | null;
    readonly check_status: MergeCheckView["status"] | null;
  }[];
  readonly system_rule_attention?: readonly {
    readonly event_id: string;
    readonly card_id: string;
    readonly work_item_id: string | null;
    readonly assignment_id: string | null;
    readonly detail: string;
    readonly waited_ms: number;
  }[];
  readonly attention?: readonly {
    readonly kind:
      | "review_limit_not_resumed"
      | "review_limit_auto_raise_exhausted";
    readonly card_id: string;
    readonly work_item_id: string;
    readonly decision_id?: string;
    readonly event_id?: string;
    readonly resolved_at: string;
    readonly waited_ms: number;
    readonly detail: string;
  }[];
  readonly decisions: readonly NeedsDecision[];
  readonly human_actions: readonly NeedsAction[];
  /** C-212: deferred items waiting for their ready condition; older servers omit it. */
  readonly later?: readonly NeedsLaterItem[];
  /** A3b: pause state and distinct system merges waiting only on the pause. */
  readonly auto_merge_pause?: {
    readonly paused: boolean;
    readonly waiting_count: number;
  };
  /** §7.4 (C-65): merge confirmations PM Ops holds; the human may answer them. */
  readonly pm_held_merges?: readonly NeedsDecision[];
  /** C-777: system merge confirmations stuck past the threshold. */
  readonly stalled_system_merges?: readonly NeedsDecision[];
  /** §7.4 知会: delegated resolutions; never blocking. */
  readonly notices?: readonly NoticeView[];
  readonly notices_next_cursor?: string | null;
  /** C-153: who looks after lost runtimes; older servers omit it. */
  readonly incident_handling?: IncidentHandling;
  readonly provider_incidents?: readonly {
    readonly profile: string;
    readonly paused: boolean;
  }[];
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
  readonly source?:
    | "auto_merge"
    | "timed_merge"
    | "system_merge"
    | "system"
    | "pm"
    | "external_message";
  readonly id: string;
  readonly kind: "merge" | "decision" | "external_message" | "human_action";
  readonly card_id: string | null;
  readonly decision_id: string | null;
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

export type NeedsTab = "decisions" | "merges" | "actions" | "later" | "notices";
export interface NeedsCounts {
  readonly total_pending: number;
  readonly tabs: Readonly<
    Record<NeedsTab, { readonly count: number; readonly attention: number }>
  >;
}

/** C-712 release note for one published version, as the Workbench reads it. */
export interface ReleaseNoteView {
  readonly version: string;
  readonly version_code: number | null;
  readonly decision_id: string | null;
  readonly body: string;
  /** Raw author of the current revision (`human`, `assignment:A-1`…). */
  readonly author: string;
  /** Present on reads; a write's returned note carries only `author`. */
  readonly author_view?: AuthorView;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

/** One version on the release-note list; `note: null` is not written yet. */
export interface ReleaseNoteEntryView {
  readonly version: string;
  readonly version_code: number | null;
  readonly decision_id: string | null;
  readonly published_at: string | null;
  readonly note: ReleaseNoteView | null;
}

export interface ReleaseNotesData {
  readonly entries: readonly ReleaseNoteEntryView[];
}

export interface WriteReleaseNoteInput {
  readonly version: string;
  readonly body: string;
  /** Revision the person edited (0 for a new note); a mismatch is rejected. */
  readonly base_revision: number;
}

export interface WriteReleaseNoteResult {
  readonly note: ReleaseNoteView;
  readonly changed: boolean;
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
  /** Existing dispatch snapshots returned by the execution read API. */
  readonly recovery_runtime?: {
    readonly machine_id?: string;
    readonly runtime_machine: string;
  };
  readonly launch_publication?: {
    readonly runtime_ref: {
      readonly machine_id?: string;
      readonly runtime_machine: string;
    } | null;
  };
  readonly queue_warning?: {
    readonly after_minutes: number;
    readonly waited_ms: number;
  };
  readonly failure_reason?: "provider_unavailable" | "mcp_unavailable";
  readonly queue_reason?:
    | "concurrency_limit"
    | "runtime_unavailable"
    | "awaiting_dispatch"
    | "provider_unavailable";
  readonly queue_ahead?: number;
  readonly queue_order?: DispatchOrder;
  readonly dispatch_tier?: 1 | 2 | 3 | 4;
  readonly dispatch_reason?: string;
  /** C-736: resources admission claimed and why; absent on older Runs. */
  readonly resource_keys?: readonly string[];
  readonly resource_reason?: string;
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
   * C-232: the session's context use from the host patrol's latest fresh
   * sample; only the Assignment's newest Run carries it. Absent when there is
   * no fresh sample, and the column shows "—".
   */
  readonly context_usage?: ContextUsage | null;
}
export interface ContextUsage {
  /** Share of the context window in use, 0..1. */
  readonly used_ratio: number;
  /** Context window size in tokens. */
  readonly window_tokens: number;
  /** C-232: exact tokens in use; older servers omit it. */
  readonly used_tokens?: number;
  /** C-232: the host's level under this project's thresholds. */
  readonly level?: "handoff" | "restart" | null;
  /** C-232: when the agent sampled it (not when the host polled). */
  readonly updated_at?: string;
}
export interface ExecutionAssignment extends AuthorView {
  readonly session_maintenance?: import("@cardigan/domain").SessionMaintenanceView;
  readonly card_priority?: number;
  readonly queue_ahead?: number;
  readonly queue_order?: DispatchOrder;
  readonly dispatch_tier?: 1 | 2 | 3 | 4;
  readonly dispatch_reason?: string;
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
  /** C-232: the Card's title; older servers omit it. */
  readonly card_title?: string | null;
  readonly work_item_id: string | null;
  /** C-531: this row's own state for its card; absent on standing rows. */
  readonly run_presence?: RunPresence;
  readonly verification_activity?: {
    readonly status: string;
    readonly label: string;
    readonly delivery_id?: string;
  };
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly session_ref: string | null;
  readonly runtime_ref: {
    machine_id?: string;
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
    /** C-296: non-standing occupancy from the shared capacity core. */
    running: number;
    /** All Agent occupancy, including standing PM/host operators. */
    total_running: number;
    limit: number;
    max_limit: number;
    queued: number;
    merge_check_slots: number;
    lease_details?: readonly string[];
    /** MC-5: configured per-machine resource slots; older servers omit it. */
    resources?: readonly {
      key: string;
      occupied: number;
      limit: number;
    }[];
  }[];
  readonly merge_checks: readonly {
    machine_id: string;
    executor_type?: "local" | "ssh" | "github";
    target_limit?: number;
    running: number;
    limit: number;
    queued: number;
  }[];
  readonly merge_config_invalid: boolean;
}

export interface ExecutionData {
  readonly assignments: readonly ExecutionAssignment[];
  readonly runs: readonly RunView[];
  readonly machines: readonly ExecutionMachine[];
}

export interface MachineCapabilityView {
  readonly key: string;
  readonly version: string | null;
  /** Null for a declared key that has never passed a check. */
  readonly verified_at: string | null;
  /** False once the 24-hour evidence window has passed, or never verified. */
  readonly available: boolean;
  /** Older servers omit it; derive from `available` then. */
  readonly state?: "verified" | "expired" | "unverified";
  /**
   * C-708: how the host checks this built-in capability (machine detail,
   * current project only); absent for private custom checks.
   */
  readonly probe?:
    | { readonly kind: "command"; readonly argv: readonly string[] }
    | { readonly kind: "search"; readonly locations: readonly string[] };
}

/** C-608 readiness patrol: fixed text per item; never worker output. */
export interface MachineReadinessView {
  readonly checked_at: string;
  readonly items: readonly {
    readonly key: string;
    readonly status: "ok" | "warning" | "repaired" | "failed" | "unknown";
    readonly detail: string;
  }[];
}

export interface ExecutionMachine {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  /** MC-5 display fields; older servers omit them. */
  readonly os?: string;
  readonly arch?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly MachineCapabilityView[];
  readonly health?: {
    readonly status: "checking" | "passed" | "failed";
    readonly checked_at: string;
    readonly blockers: readonly string[];
    readonly available: boolean;
  } | null;
}

export interface MachineDiskUsageKind {
  readonly bytes: number;
  readonly directories: number;
}

/**
 * C-512: the human-only machine read (C-509). Machines are global; each
 * binding is one project's registration of the machine, as far as the server
 * authorises it. Only these fields are read; credentials never appear here.
 */
export interface MachineBindingView {
  readonly project_id: string;
  readonly project_name: string;
  readonly is_current: boolean;
  readonly status: string;
  readonly last_seen: string | null;
  /** Account, directory and session summary; null without a binding. */
  readonly runtime: {
    readonly account: string | null;
    readonly directory: string | null;
    readonly session: string;
    readonly path_entries: number;
  } | null;
  /** False when the host's private configuration could not be read. */
  readonly config_available: boolean;
  readonly capabilities: readonly MachineCapabilityView[];
  /**
   * C-708: what the latest machine check recorded for capabilities it could
   * not verify (current project only; older servers omit it). Fixed host
   * text and search labels, never command output.
   */
  readonly capability_failures?: readonly {
    readonly key: string;
    readonly search_locations: readonly string[];
    readonly search_incomplete?: true;
    readonly reason?: string;
  }[];
  /** The latest machine check (health) for this project. */
  readonly machine_check: {
    readonly status: "checking" | "passed" | "failed";
    readonly checked_at: string;
    readonly blockers: readonly string[];
    readonly available: boolean;
    /** C-608: non-blocking findings; older servers omit them. */
    readonly warnings?: readonly string[];
    readonly readiness?: MachineReadinessView;
  } | null;
  /**
   * C-666: this project's worktrees/builds/runs on a remote worker and the
   * volume's free space; null on `local` or before the first read (older
   * servers omit it). A skipped read keeps the last measurement.
   */
  readonly disk_usage?: {
    readonly observed_at: string;
    readonly status: "measured" | "skipped";
    readonly skipped_reason?: "helper_outdated" | "failed";
    readonly measured?: {
      readonly measured_at: string;
      readonly free_bytes: number;
      readonly total_bytes: number;
      readonly worktrees: MachineDiskUsageKind;
      readonly builds: MachineDiskUsageKind;
      readonly runs: MachineDiskUsageKind;
      readonly complete: boolean;
    };
  } | null;
  /** The latest explicitly requested check (Web or CLI). */
  readonly last_requested_check: {
    readonly id: string;
    readonly kind: "machine" | "worker";
    readonly status: "running" | "passed" | "failed";
    readonly step: string;
    readonly checked_at: string;
    readonly failed_steps: readonly string[];
  } | null;
  /** The latest worker onboarding check; `local` has none. */
  readonly worker_check: {
    readonly status: "failed" | "passed" | "checking" | "unknown";
    readonly checked_at: string;
    readonly failed_steps: readonly string[];
  } | null;
  readonly worker_record_readable: boolean;
  readonly assignments: readonly {
    readonly assignment_id: string;
    readonly role_id: string;
    readonly employee_id: string | null;
    readonly employee_name: string | null;
    readonly card_id: string | null;
    readonly runs: readonly {
      readonly id: string;
      readonly status: string;
      readonly card_id: string | null;
    }[];
  }[];
}
export interface MachineView {
  readonly id: string;
  readonly label: string;
  readonly os: string;
  readonly arch: string;
  /** The most restrictive status across bindings; absent if none is known. */
  readonly status?: string;
  readonly last_seen: string | null;
  readonly run_limit: number;
  readonly run_limit_maximum: number;
  readonly resources: readonly {
    readonly key: string;
    readonly limit: number;
  }[];
  /** C-800: open calendar reservations of every project on this machine. */
  readonly reservations?: readonly MachineReservationView[];
  readonly bindings: readonly MachineBindingView[];
}
/** C-800: reservation metadata only; never the holder project's cards. */
export interface MachineReservationView {
  readonly reservation_id: string;
  readonly resource: string;
  readonly holder_project: string;
  readonly source: "human" | "standing_pm" | "unknown";
  readonly starts_at: string;
  readonly ends_at: string;
}

/**
 * C-725/C-727: which usage note of the current project's capability catalog:
 * a capability key's main note, or its supplement for one machine.
 */
export type CapabilityGuideTarget =
  | {
      readonly scope: "capability";
      readonly key: string;
      readonly machine_id: null;
    }
  | {
      readonly scope: "machine";
      readonly key: string;
      readonly machine_id: string;
    };

/** C-727: the notes of one machine's capabilities, merged by the server. */
export interface CapabilityGuidesView {
  readonly merged: {
    readonly machine_id: string | null;
    readonly capabilities: readonly {
      readonly key: string;
      readonly usage_note: string | null;
      readonly machine_note: string | null;
    }[];
  };
}

/** C-511: one explicit machine check (C-509), polled until it ends. */
export interface MachineCheckJob {
  readonly id: string;
  readonly project_id: string;
  readonly machine_id: string;
  readonly kind: "machine" | "worker";
  readonly status: "running" | "passed" | "failed";
  /** The step in progress, `queued` before it starts, `finished` after. */
  readonly step: string;
  readonly started_at: string;
  readonly checked_at: string;
  readonly failed_steps: readonly string[];
}

/** C-511: what the add-worker wizard asks for (C-510); data only, no YAML. */
export interface WorkerWizardInput {
  readonly machine_id: string;
  readonly label: string;
  readonly os: "linux" | "macos";
  readonly arch: "x64" | "arm64";
  readonly host: string;
  readonly port?: number;
  readonly account: string;
  readonly uid: number;
  readonly gid: number;
  readonly mcp_url: string;
}
/** C-565: what the host already knows for a new worker (owner only). */
export interface WorkerWizardDefaults {
  /**
   * The HTTPS `/mcp` address existing remote workers use (`workers`), or the
   * host's explicit remote MCP address when none is bound yet (`host`).
   */
  readonly mcp_url?: string;
  readonly mcp_source?: "workers" | "host";
}
export type WorkerWizardStepName =
  | "configuration"
  | "registration"
  | "draft"
  | "ssh"
  | "account"
  | "directories"
  | "tools"
  | "helpers"
  | "resources"
  | "mcp"
  | "capabilities";
export type WorkerWizardCommandKey =
  | "account"
  | "directories"
  | "helpers"
  | "tools";
export interface WorkerWizardStep {
  readonly step: WorkerWizardStepName;
  readonly state: "pending" | "running" | "passed" | "blocked";
  readonly elapsed_ms: number;
  readonly reason?: string;
  readonly next?: string;
  readonly command_key?: WorkerWizardCommandKey;
}
/** C-705/C-707: a paired device's own report of itself. */
export interface WorkerPairingDevice {
  readonly hostname: string;
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  readonly address: string;
  readonly free_id: number;
  readonly system?: string;
  readonly root_readonly?: boolean;
  readonly cpu?: string;
  readonly cpu_cores?: number;
  readonly memory_bytes?: number;
  readonly disk_path?: string;
  readonly disk_total_bytes?: number;
  readonly disk_free_bytes?: number;
  readonly gpu?: string;
}
/** A server-side wizard session; it lives 24 hours in the Web process. */
export interface WorkerWizardView {
  readonly id: string;
  readonly machine_id: string;
  readonly project_id: string;
  readonly label: string;
  readonly os: string;
  readonly arch: string;
  readonly phase:
    | "preview"
    | "ready"
    | "running"
    | "failed"
    | "passed"
    | "enabled";
  readonly steps: readonly WorkerWizardStep[];
  /** Admin commands for the target machine, as text; never run here. */
  readonly commands: Readonly<Record<WorkerWizardCommandKey, string>>;
  readonly command_guide: string;
  readonly command_prerequisites: string;
  readonly check_id?: string;
  readonly error?: string;
  /** C-706: a draft from a device pairing: the device's one-time init script. */
  readonly device_init?: {
    readonly state: "waiting" | "fetched" | "succeeded" | "failed";
    readonly at?: string;
  };
  /** C-707: what a paired device reported about itself (unverified). */
  readonly device?: WorkerPairingDevice;
  /**
   * C-707: the Agent limit chosen when pairing; set when the check first
   * registers the machine (`applied`), unchanged for a known one (`kept`).
   */
  readonly run_limit?: {
    readonly value: number;
    readonly state: "pending" | "applied" | "kept";
  };
  /** C-707: host facts for the onboarding report, once the checks passed. */
  readonly report?: {
    readonly capabilities: readonly {
      readonly key: string;
      readonly version: string | null;
      readonly verified_at: string | null;
      readonly state: "verified" | "expired" | "unverified";
    }[];
    /** Catalog tools for this system not verified yet. */
    readonly suggested: readonly string[];
  };
  /** The pending file change; private values are redacted by the server. */
  readonly preview?: {
    readonly preview_id: string;
    readonly expires_at: string;
    readonly file: string;
    readonly diff: readonly {
      readonly field: string;
      readonly change: string;
      readonly before?: string | number | boolean;
      readonly after?: string | number | boolean;
    }[];
  };
}

/**
 * One wizard step request. `confirm` writes the previewed worker file;
 * `enable` turns on remote launch, which the reader confirms separately.
 */
export type WorkerWizardAction =
  | { readonly kind: "run" | "cancel" | "launch-preview" }
  /**
   * C-565: an automatic recheck continues only the failed check it saw; the
   * server refuses it (`worker_check_changed`) once the session moved on.
   */
  | { readonly kind: "run"; readonly resume_check_id: string }
  | { readonly kind: "confirm"; readonly preview_id: string }
  | {
      readonly kind: "enable";
      readonly preview_id: string;
      readonly allow_remote_launch: true;
    };

/** C-75: one server page of an Assignment's Run history, newest first. */
export interface ExecutionRunPage {
  readonly runs: readonly RunView[];
  readonly total: number;
  /** Pass as `before` to read the next page; null on the last page. */
  readonly next_cursor: string | null;
}

/** C-703: what a Workbench stop did (`cardigan assignment stop`). */
export interface AssignmentStopResult {
  readonly released: boolean;
  readonly aborted: boolean;
  readonly held?: boolean;
  /** The session it was asked to stop had been settled or replaced. */
  readonly stale?: boolean;
}
/** C-703: an Assignment's worktree changes (`cardigan worktree diff`). */
export interface AssignmentDiff {
  readonly worktree_path: string;
  readonly branch?: string;
  readonly head_sha: string;
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly reachable: boolean;
  /** `git diff HEAD`, cut at a line end when `truncated`. */
  readonly patch: string;
  readonly truncated: boolean;
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
  readonly section?: "overview";
  readonly before?: string;
  readonly type?: string;
  readonly author?: string;
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
    /** C-617 / Q-1198: the owner's answer cited as evidence for PM's decision. */
    owner_record?: {
      readonly card_id: string;
      readonly timeline_entry_id: string;
      readonly quote: string;
      readonly at: string;
      readonly attachment_id?: string;
    };
  };
}
/** C-134: newest 10 first; pass `next_cursor` back to read the next 10. */
export interface DecisionHistoryPage {
  readonly decisions: readonly DecisionHistoryRecord[];
  readonly next_cursor: string | null;
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
  story?: true;
  requires_state_and_save?: boolean;
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

export interface SystemReminderPolicy {
  readonly min_minutes: number;
  readonly max_minutes: number;
  readonly min_count: number;
  readonly max_count: number;
  readonly unassigned_ready_after_minutes: number | null;
  readonly pre_merge_check_pending_after_minutes: number | null;
  readonly repeat: boolean;
  readonly repeat_interval_minutes: number | null;
  readonly max_reminders: number;
}
export interface SystemRulesPreferences {
  readonly system_auto_assign_verifiers?: boolean;
  readonly system_reminders?: boolean;
  readonly pm_owner_messages?: boolean;
  readonly system_reminder_policy?: SystemReminderPolicy | null;
}
export interface PreferencesView extends SystemRulesPreferences {
  readonly cross_card_read?: boolean;
  readonly auto_merge_paused?: boolean;
  /** Unset follows each card's flow; off explicitly disables system merging. */
  readonly auto_merge?: "off" | "on";
  readonly flow_version?: number;
  readonly high_risk_paths?: readonly string[];
  readonly decision_delegation?: Readonly<Record<string, boolean>>;
  /** Merge confirmations go to PM Ops; missing means the default (on). */
  readonly pm_merge_confirmation?: boolean;
  readonly pm_confirm_role_rule_implementations?: boolean;
  readonly pm_confirm_human_decided_merges?: boolean;
  readonly auto_merge_after_minutes: number | null;
  /** C-177: PM-held merge confirmation stall alert; older servers omit it. */
  readonly merge_confirm_stall_after_minutes?: number;
  readonly merge_confirm_snooze_default_minutes?: number;
  readonly merge_confirm_snooze_max_minutes?: number;
  readonly merge_gate_enabled: boolean;
  /** C-253: initial review limits of new verifiers; older servers omit them. */
  readonly review_max_rounds?: number;
  readonly independent_review_max_rounds?: number;
  readonly independent_review_limit_delegation?: boolean;
  readonly independent_review_limit_delegation_max?: number | null;
  readonly independent_review_limit_delegation_ceiling?: number;
  /** Largest accepted review limit; the domain owns the value (Q-420). */
  readonly review_max_rounds_ceiling?: number;
  /** Lanes the human folded (true) or unfolded (false); missing = default. */
  readonly board_collapsed_lanes?: Readonly<Record<string, boolean>>;
  /** C-684: templates people may open cards from; older servers omit it. */
  readonly human_card_templates?: readonly string[];
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

/** C-494: a launch profile the host has loaded; never endpoints or secrets. */
export interface LaunchProfileOption {
  readonly name: string;
  readonly harness: string;
  readonly model: string | null;
}

export interface RoleListView {
  readonly project_id: string;
  readonly roles: readonly RoleSummary[];
  readonly default_roles: readonly string[];
  readonly harnesses: readonly string[];
  readonly allowlists: RoleAllowlists;
  /** Older servers omit it; role pickers then offer no profiles. */
  readonly launch_profiles?: readonly LaunchProfileOption[];
}

/** One global employee as listed in the employee settings. */
export interface EmployeeSummary extends CreatedEmployee {
  readonly title?: string;
  readonly status?: "active" | "inactive";
  readonly avatar?: string | null;
  /** Why a role change would be refused now: an unfinished run or a bound assignment. */
  readonly role_change_blocked?: "run" | "assignment" | null;
}

/** C-515 `GET /api/launch-settings`: global, read-only; secret values never leave the host. */
export interface LaunchModelMetadata {
  readonly cost?: { readonly input: number; readonly output: number };
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly reasoning_efforts?: readonly string[];
}
export type LaunchProfileReference =
  | {
      readonly project_id: string;
      readonly role_id: string;
      readonly version: number;
      readonly name: string;
    }
  | { readonly employee_id: string; readonly name: string };
export interface LaunchProfileCheck {
  readonly id: string;
  readonly version: string;
  readonly mode: "metadata" | "online";
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: "passed" | "failed" | "running" | "interrupted";
  readonly problems: readonly string[];
  readonly cli_version: string | null;
}
export interface LaunchProfileView {
  readonly name: string;
  readonly harness: string;
  readonly provider: string | null;
  readonly model_alias: string | null;
  readonly model_id: string | null;
  readonly metadata: LaunchModelMetadata | null;
  readonly parameters: {
    readonly effort: string | null;
    readonly permission_mode: string | null;
    readonly auto_update: boolean | null;
    readonly provider_flag: string | null;
    readonly custom_args_count: number;
    readonly custom_config_count: number;
  };
  readonly cli: {
    readonly path: string | null;
    readonly version: string | null;
  };
  readonly secrets: readonly { readonly key: string; readonly set: boolean }[];
  readonly references: readonly LaunchProfileReference[];
  readonly last_check: LaunchProfileCheck | null;
}
export interface LaunchProviderView {
  readonly id: string;
  readonly name: string;
  readonly base_url: string | null;
  /** C-515: environment variable → secrets.env key name (never the value). */
  readonly secret_env?: Readonly<Record<string, string>>;
  /** C-549: `null` when launch.yaml leaves it to the profile (or `api`). */
  readonly harness?: string | null;
  readonly api?: string | null;
  /** Plain variables; `value` is `null` when it may hold a credential. */
  readonly env?: readonly {
    readonly name: string;
    readonly value: string | null;
  }[];
  /** Each secret variable, whether its key is set, and when the Web last wrote it. */
  readonly secrets?: readonly LaunchProviderSecret[];
  /** Profiles and model aliases that use this Provider. */
  readonly profiles?: readonly string[];
  readonly models?: readonly string[];
  readonly last_check?: LaunchProfileCheck | null;
}
export interface LaunchProviderSecret {
  readonly env: string;
  readonly key: string;
  readonly set: boolean;
  readonly updated_at: string | null;
}
/** A model alias in launch.yaml: the concrete id it names, plus metadata. */
export interface LaunchModelView extends LaunchModelMetadata {
  readonly id: string;
  readonly provider?: string;
}
export interface LaunchSettingsView {
  readonly version: string;
  readonly profiles: readonly LaunchProfileView[];
  readonly providers: readonly LaunchProviderView[];
  readonly models?: Readonly<Record<string, LaunchModelView>>;
  /** Key names present in secrets.env; values never leave the host. */
  readonly secret_keys?: readonly string[];
  /** C-564: the `permission_mode` values offered per harness (none = not used). */
  readonly permission_modes?: Readonly<Record<string, readonly string[]>>;
}

/** C-564 `POST /api/launch-settings/models`: one saved Provider's model choices. */
export interface LaunchModelOption extends LaunchModelMetadata {
  readonly id: string;
  /** Found in the models.dev catalog, the Provider's own listing, or both. */
  readonly sources: readonly ("catalog" | "provider")[];
}
export interface LaunchModelList {
  readonly version: string;
  readonly provider: string;
  readonly catalog: {
    readonly status: "ok" | "stale" | "unavailable" | "not_listed";
    readonly providers: readonly string[];
    readonly fetched_at: string | null;
  };
  readonly listing: {
    readonly status:
      | "ok"
      | "partial"
      | "failed"
      | "no_endpoint"
      | "missing_secret";
  };
  readonly models: readonly LaunchModelOption[];
}
/** C-564 `POST /api/launch-settings/model-check`: a typed ID against the saved Provider's list. */
export interface LaunchModelCheck {
  readonly provider: string;
  readonly model: string;
  readonly status:
    | "listed"
    | "not_listed"
    | "incomplete"
    | "failed"
    | "no_endpoint"
    | "missing_secret";
}

/** C-515 profile fields a person may set; `null` clears an optional one. */
export interface LaunchProfileFields {
  readonly harness?: string;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly permission_mode?: string | null;
  readonly provider_flag?: string | null;
  readonly auto_update?: boolean | null;
}
/** C-515 `POST /api/launch-settings/preview` change, one per preview. */
export type LaunchChange =
  | {
      readonly op: "create_profile" | "edit_profile";
      readonly name: string;
      readonly fields: LaunchProfileFields;
    }
  | {
      readonly op: "copy_profile";
      readonly name: string;
      readonly source: string;
    }
  | { readonly op: "delete_profile"; readonly name: string }
  | { readonly op: "set_model"; readonly name: string; readonly id: string }
  | {
      readonly op: "create_provider" | "edit_provider";
      readonly name: string;
      readonly fields: LaunchProviderFields;
      /** C-549: key names only; values go with the confirmation. */
      readonly secrets?: {
        readonly set?: readonly string[];
        readonly clear?: readonly string[];
      };
    }
  | { readonly op: "delete_provider"; readonly name: string };
/** C-549 Provider fields; `null` removes an optional one (or one variable). */
export interface LaunchProviderFields {
  readonly name?: string;
  readonly harness?: string | null;
  readonly api?: string | null;
  readonly base_url?: string | null;
  readonly env?: Readonly<Record<string, string | null>>;
  readonly secret_env?: Readonly<Record<string, string | null>>;
}
export interface LaunchPreview {
  readonly version: string;
  readonly preview_id: string;
  readonly diff: readonly {
    readonly field: string;
    readonly before: unknown;
    readonly after: unknown;
  }[];
}
export interface LaunchCheckStarted {
  readonly id: string;
  readonly profile: string;
  readonly mode: LaunchProfileCheck["mode"];
  readonly version: string;
  readonly status: "running";
}

export interface EmployeeOptions {
  readonly employees?: readonly EmployeeSummary[];
  readonly library: readonly {
    readonly id: string;
    readonly name: string;
    readonly source: string;
    readonly avatar: string;
    readonly occupied_by: {
      readonly id: string;
      readonly name: string;
      readonly status: "active" | "inactive";
    } | null;
  }[];
  readonly roles: readonly {
    readonly role_id: string;
    readonly display_name: string;
    /** C-516: the role's launch profile; older servers omit it. */
    readonly launch_profile_ref?: string;
  }[];
}
/** C-493/C-516: change an employee's role, launch profile, or both. */
export interface EmployeePatch {
  readonly role_id?: string;
  /** A pinned profile, or null to follow the role. */
  readonly launch_profile_ref?: string | null;
}
/** `@` candidates for one card's comment box (active employees only). */
export interface MentionCandidate {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly avatar: string | null;
  /** Works on the card, wrote on its timeline, or is a standing PM. */
  readonly related: boolean;
}
export interface MentionCandidates {
  readonly employees: readonly MentionCandidate[];
}
export interface CreateEmployeeInput {
  readonly projects?: readonly string[];
  readonly launch_profile_ref?: string | null;
  readonly name: string;
  readonly title: string;
  readonly role_id: string;
  readonly bio?: string;
  readonly avatar?: string;
  /** Canonical base64; the server identifies and stores the bitmap. */
  readonly avatar_file?: string;
}
export interface CreatedEmployee {
  readonly projects?: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly role_id: string;
  /** C-516 (employee options): a pinned launch profile; null follows the role. */
  readonly launch_profile_ref?: string | null;
}

/** C-492 role document preview; apply returns the same shape after writing. */
export interface RoleDocumentPreview {
  readonly snapshot: string;
  readonly role: {
    readonly action: "create" | "update" | "unchanged";
    readonly role: RoleDefinitionView;
    readonly fields: readonly {
      readonly field: string;
      readonly before: unknown;
      readonly after: unknown;
    }[];
    readonly relaxations: readonly string[];
  };
  readonly template: {
    readonly action: "create" | "update" | "unchanged";
    readonly before: (TemplateDefinition & { version: number }) | null;
    readonly after: TemplateDefinition & { version: number };
  } | null;
  readonly employees: readonly {
    readonly name: string;
    readonly title: string;
    readonly bio?: string;
    readonly role_id: string;
    readonly launch_profile_ref: string | null;
    readonly action: "create" | "unchanged";
    readonly id: string | null;
  }[];
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

export interface FeishuBindingView {
  state: string;
  bound: boolean;
  code?: string;
  expires?: number;
}
/** C-558: the five write-only Feishu credentials; only their state is ever read. */
export const FEISHU_SECRET_KEYS = [
  "lark_webhook",
  "lark_sign_secret",
  "app_id",
  "app_secret",
  "tenant_key",
] as const;
export type FeishuSecretKey = (typeof FEISHU_SECRET_KEYS)[number];
export type FeishuChannel = "lark" | "lark_app";
/**
 * C-558 `GET /api/feishu-settings`: dotted YAML keys to values (durations in
 * milliseconds). A string that contains a credential reads as `null`.
 */
export interface FeishuSettingsView {
  readonly version: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<
    Record<
      FeishuSecretKey,
      { readonly set: boolean; readonly updated_at: string | null }
    >
  >;
}
export interface FeishuSettingsChange {
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly secrets?: {
    readonly set: readonly FeishuSecretKey[];
    readonly clear: readonly FeishuSecretKey[];
  };
}
export interface FeishuSettingsPreview {
  readonly version: string;
  readonly preview_id: string;
  readonly diff: readonly {
    readonly key: string;
    readonly before: unknown;
    readonly after: unknown;
  }[];
  readonly restart_required: boolean;
}
/** `timeout` and `unknown` are no proof of delivery. */
export type FeishuTestResult =
  | "sent"
  | "permanent"
  | "retryable"
  | "timeout"
  | "unknown";

/** C-807: the bucket refuses browser uploads; the rule the owner adds. */
export interface StorageCorsBlock {
  readonly reason: "not_enabled" | "not_allowed";
  readonly rule: {
    readonly origins: readonly string[];
    readonly methods: readonly string[];
    readonly headers: readonly string[];
  };
}
/** C-614: off-site copy health of the control host (counts only). */
export interface OffsiteStatusView {
  readonly configured: "absent" | "invalid" | "ready";
  readonly bucket?: string;
  readonly region?: string;
  readonly synced: { readonly count: number; readonly bytes: number };
  readonly pending: { readonly count: number; readonly bytes: number };
  readonly failed: {
    readonly count: number;
    readonly last_code?: string;
    readonly last_at?: string;
  };
  readonly last_success_at?: string;
  readonly checked_at?: string;
  readonly usage: {
    readonly month: string;
    readonly egress_bytes: number;
    readonly process_bytes: number;
    readonly requests: number;
    readonly estimated_yuan: number;
    readonly budget_yuan?: number;
  };
  /** C-628: event-loop delay of the syncing process and of the server. */
  readonly loop_delay?: {
    readonly sync?: OffsiteLoopDelay;
    readonly server?: OffsiteLoopDelay;
  };
  /** C-807: last browser-upload preflight per Workbench origin. */
  readonly cors?: {
    readonly checked_at: string;
    readonly origins: readonly {
      readonly origin: string;
      readonly verdict:
        | "ok"
        | "not_enabled"
        | "not_allowed"
        | "unreachable"
        | "error";
      readonly status?: number;
    }[];
    readonly blocked?: StorageCorsBlock;
  };
  readonly alerts: readonly (
    | "config_invalid"
    | "unreachable"
    | "sync_failed"
    | "over_budget"
    | "loop_slow"
    | "cors_blocked"
  )[];
}
/** C-638: V8 heap use against its limit, per server process (numbers only). */
export interface ProcessHealthView {
  readonly processes: readonly {
    readonly role: "web" | "background" | "server";
    readonly heap_used_bytes: number;
    readonly heap_limit_bytes: number;
    readonly rss_bytes: number;
    readonly checked_at: string;
  }[];
}
export interface OffsiteLoopDelay {
  readonly p99_ms: number;
  readonly max_ms: number;
  readonly window_ms: number;
}

export interface CardiganClient {
  /** C-614: null when this server has no off-site copy wired. */
  offsiteStatus?(): Promise<OffsiteStatusView | null>;
  /** C-638: heap use and limit of the server processes. */
  processHealth?(): Promise<ProcessHealthView>;
  feishuBinding?(action?: "code" | "unbind"): Promise<FeishuBindingView>;
  /** C-561: Feishu bot settings (human sessions only; 403 otherwise). */
  feishuSettings?(): Promise<FeishuSettingsView>;
  /** Diff of `change` against `version`; never carries credential values. */
  previewFeishuSettings?(
    version: string,
    change: FeishuSettingsChange,
  ): Promise<FeishuSettingsPreview>;
  /** Apply a preview; credential values travel only here. */
  confirmFeishuSettings?(
    version: string,
    previewId: string,
    idempotencyKey: string,
    secrets?: Readonly<Partial<Record<FeishuSecretKey, string>>>,
  ): Promise<void>;
  /** One person-requested test message; a new key for every click. */
  testFeishuChannel?(
    channel: FeishuChannel,
    idempotencyKey: string,
  ): Promise<FeishuTestResult>;
  /** In-memory only, scoped to the currently validated login. */
  cachedCards?(
    projectId: string,
    filter: CardFilter,
    options: Readonly<Record<string, string>>,
  ): CardPage | undefined;
  cardPreferenceScope?(): string | undefined;
  employeeOptions(projectId: string): Promise<EmployeeOptions>;
  /** Global launch profiles (not project scoped). */
  launchSettings(): Promise<LaunchSettingsView>;
  /** C-515: a diff of one change against `version`; nothing is written. */
  previewLaunchChange(
    version: string,
    change: LaunchChange,
  ): Promise<LaunchPreview>;
  /** C-515: write a previewed change (validated, backed up, hot reloaded). */
  confirmLaunchChange(
    version: string,
    previewId: string,
    idempotencyKey: string,
    /** C-549: values for the keys the preview sets; only ever sent here. */
    secrets?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** C-515: a person starts a local check or an online model listing. */
  startLaunchCheck(
    version: string,
    profile: string,
    mode: LaunchProfileCheck["mode"],
  ): Promise<LaunchCheckStarted>;
  /** C-564: a saved Provider's model choices (catalog + its own listing; no inference). */
  launchModels(version: string, provider: string): Promise<LaunchModelList>;
  /** C-564: whether the saved Provider lists a typed model ID (nothing saved, no inference). */
  checkLaunchModel(
    version: string,
    provider: string,
    model: string,
  ): Promise<LaunchModelCheck>;
  /** C-549: list the Provider's models once (no profile, no inference). */
  startProviderCheck(
    version: string,
    provider: string,
  ): Promise<LaunchCheckStarted>;
  createEmployee(
    projectId: string,
    input: CreateEmployeeInput,
    idempotencyKey: string,
  ): Promise<CreatedEmployee>;
  /** C-493: a role change is a transfer; the server refuses while work is bound. C-516: or pin/clear the launch profile. */
  updateEmployee(
    projectId: string,
    employeeId: string,
    patch: EmployeePatch,
    idempotencyKey: string,
  ): Promise<CreatedEmployee>;
  previewRoleDocument(
    projectId: string,
    markdown: string,
  ): Promise<RoleDocumentPreview>;
  applyRoleDocument(
    projectId: string,
    markdown: string,
    snapshot: string,
    idempotencyKey: string,
  ): Promise<RoleDocumentPreview>;
  exportRole(projectId: string, roleId: string): Promise<{ markdown: string }>;
  /** C-515: the launch profile names roles and employees may use (global). */
  launchProfileNames(): Promise<readonly string[]>;
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
    /** C-503: the story summary the person confirmed against. */
    storySummaryEntryId?: string,
  ): Promise<void>;
  /** C-503: confirm the story proposal version the person saw. */
  confirmStoryProposal(
    projectId: string,
    cardId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<StoryConfirmation>;
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
    cursor?: string,
  ): Promise<DecisionHistoryPage>;
  setDelegation(
    projectId: string,
    category: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  /** C-684: open or close one template to people; only that entry is sent. */
  setHumanCardTemplates(
    projectId: string,
    changes: Readonly<Record<string, boolean>>,
    idempotencyKey: string,
  ): Promise<void>;
  setCrossCardRead(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setAutoMerge(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setAutoMergePaused(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setPmConfirmHumanDecidedMerges(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setPmConfirmRoleRuleImplementations(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setPmMergeConfirmation(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  setMergeConfirmSnoozeDefault(
    projectId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<void>;
  setMergeConfirmSnoozeMax(
    projectId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<void>;
  setMergeConfirmStallAfter(
    projectId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<void>;
  setReviewMaxRounds(
    projectId: string,
    kind: "review" | "independent",
    rounds: number,
    idempotencyKey: string,
  ): Promise<void>;
  setIndependentReviewLimitDelegation(
    projectId: string,
    enabled: boolean,
    max: number | null,
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
  setSystemRules(
    projectId: string,
    input: SystemRulesPreferences,
    idempotencyKey: string,
  ): Promise<void>;
  setManualAssign(
    projectId: string,
    workItemId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void>;
  /** C-778: hand the template's primary slot to another producer. */
  replacePrimaryWorkItem(
    projectId: string,
    workItemId: string,
    input: PrimaryReplacementInput,
    idempotencyKey: string,
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
    input:
      | CardUpdateInput
      | { hold: Pick<CardHold, "reason" | "resume_condition"> | null },
    idempotencyKey?: string,
  ): Promise<void>;
  /** `entry_id` is the creation timeline entry the dialog attaches files to. */
  createCard(
    projectId: string,
    input: CreateCardInput,
    key: string,
  ): Promise<CreatedCard>;
  cancelCard(
    projectId: string,
    cardId: string,
    reason: string,
    idempotencyKey?: string,
    children?: StoryChildChoice,
  ): Promise<void>;
  supersedeCard(
    projectId: string,
    cardId: string,
    supersededBy: string,
    idempotencyKey?: string,
  ): Promise<void>;
  mergeBatch(
    projectId: string,
    batchId: string,
  ): Promise<{ batch: MergeBatchView; probes: readonly MergeBatchView[] }>;
  setMergeSolo(
    projectId: string,
    cardId: string,
    solo: boolean,
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
  /** C-713: every published version and its release note, newest first. */
  releaseNotes(projectId: string): Promise<ReleaseNotesData>;
  writeReleaseNote(
    projectId: string,
    input: WriteReleaseNoteInput,
    idempotencyKey: string,
  ): Promise<WriteReleaseNoteResult>;
  executionCapacity(projectId: string): Promise<ExecutionCapacity>;
  setRunLimit(
    projectId: string,
    machineId: string,
    limit: number,
    idempotencyKey: string,
  ): Promise<void>;
  executionDiagnostics?(projectId: string): Promise<ExecutionDiagnosticsData>;
  /** C-512: the machine read. */
  machines(projectId: string): Promise<{ machines: readonly MachineView[] }>;
  machine(
    projectId: string,
    machineId: string,
  ): Promise<{ machine: MachineView }>;
  /**
   * C-511: human-only machine actions (C-509) and the add-worker wizard
   * (C-510). Optional so read-only fixtures need not provide them; the page
   * hides an action its client lacks.
   */
  /**
   * Each click carries its own operation key, but is never resent
   * automatically: the server does not dedupe by key (a check that just
   * ended is not joined), so a resend could act twice. After a failure the
   * page reads the machine back before allowing another click.
   */
  checkMachine?(
    projectId: string,
    machineId: string,
    idempotencyKey: string,
  ): Promise<{ check: MachineCheckJob }>;
  machineCheck?(
    projectId: string,
    machineId: string,
    checkId: string,
  ): Promise<{ check: MachineCheckJob }>;
  setMachineDrain?(
    projectId: string,
    machineId: string,
    drain: boolean,
    idempotencyKey: string,
  ): Promise<{ machine_id: string; status: string }>;
  /** C-800: end a calendar reservation early; owner's human session only. */
  cancelMachineReservation?(
    projectId: string,
    machineId: string,
    reservationId: string,
    reason: string,
  ): Promise<{ reservation_id: string; released_runs: number }>;
  createWorkerWizard?(
    projectId: string,
    input: WorkerWizardInput,
  ): Promise<{ wizard: WorkerWizardView }>;
  /** C-565: values the host can suggest for a new worker form. */
  /**
   * C-707: a device pairing code becomes a wizard draft in this project, with
   * the Agent limit for the new machine. Owner's human session only.
   */
  pairWorkerDevice?(
    projectId: string,
    input: { readonly code: string; readonly run_limit: number },
  ): Promise<{ wizard: WorkerWizardView; device: WorkerPairingDevice }>;
  /**
   * C-727: the capability usage notes (C-725) merged for one machine. Writes
   * are the owner's human session only; any Agent Token is refused (403).
   * Optional so fixtures without notes need not provide them.
   */
  capabilityGuides?(
    projectId: string,
    machineId: string,
  ): Promise<CapabilityGuidesView>;
  setCapabilityGuide?(
    projectId: string,
    target: CapabilityGuideTarget,
    note: string,
  ): Promise<void>;
  /** Resolves when the entry is gone, also when it was already gone. */
  deleteCapabilityGuide?(
    projectId: string,
    target: CapabilityGuideTarget,
  ): Promise<void>;
  workerWizardDefaults?(
    projectId: string,
  ): Promise<{ defaults: WorkerWizardDefaults }>;
  workerWizard?(
    projectId: string,
    wizardId: string,
  ): Promise<{ wizard: WorkerWizardView }>;
  workerWizardAction?(
    projectId: string,
    wizardId: string,
    action: WorkerWizardAction,
  ): Promise<{ wizard: WorkerWizardView } | { cancelled: true }>;
  execution(projectId: string): Promise<ExecutionData>;
  executionRuns(
    projectId: string,
    assignmentId: string,
    before?: string,
  ): Promise<ExecutionRunPage>;
  /** C-703: start (or, with `restart`, stop then start) a session. */
  startAssignment(
    projectId: string,
    assignmentId: string,
    restart: boolean,
    idempotencyKey: string,
  ): Promise<{ readonly run_id: string }>;
  /** C-703: stop the session and cancel its current Run. */
  stopAssignment(
    projectId: string,
    assignmentId: string,
    idempotencyKey: string,
  ): Promise<AssignmentStopResult>;
  assignmentDiff(
    projectId: string,
    assignmentId: string,
  ): Promise<AssignmentDiff>;
  needsYou(projectId: string, invalidation?: string): Promise<NeedsPage>;
  needsYouCounts(
    projectId: string,
    invalidation?: string,
  ): Promise<NeedsCounts>;
  needsYouSection(
    projectId: string,
    section: NeedsTab,
    invalidation?: string,
  ): Promise<NeedsPage>;
  notices(projectId: string, before: string): Promise<NoticesPage>;
  recheckMerge(
    projectId: string,
    cardId: string,
    completionId: string,
    idempotencyKey?: string,
  ): Promise<void>;
  confirmSourceUnrelated(
    projectId: string,
    id: string,
    cardId: string,
    sourceId: string,
    version: number,
    key: string,
  ): Promise<void>;
  recordDecision(
    projectId: string,
    id: string,
    option: string,
    quote: string,
    idempotencyKey?: string,
    delegateFuture?: boolean,
    snoozeUntil?: string,
    mergeOverrideReason?: string,
    /** C-760: with an override, turn open merge holds into follow-ups. */
    mergeOverrideFollowUp?: boolean,
  ): Promise<void>;
  /** C-192: submit the decision's fresh suggestion ("按建议处理"). */
  applySuggestion(
    projectId: string,
    id: string,
    option: string,
    quote: string,
    idempotencyKey?: string,
    progressToken?: string,
    suggestionVersion?: number,
  ): Promise<void>;
  decisionComment(
    projectId: string,
    id: string,
    action: "request_information" | "explain",
    body: string,
    idempotencyKey?: string,
  ): Promise<void>;
  cancelAction(
    projectId: string,
    id: string,
    reason: string,
    idempotencyKey?: string,
  ): Promise<void>;
  /** C-760: switch an action between holding the merge and a follow-up. */
  setActionMergeBlocking(
    projectId: string,
    id: string,
    input: MergeBlockingInput,
    idempotencyKey?: string,
  ): Promise<void>;
  /** C-742: hand a human action to the owner or to 张良. */
  reassignAction(
    projectId: string,
    id: string,
    executor: "owner" | "operator",
    reason: string,
    idempotencyKey?: string,
  ): Promise<void>;
  completeAction(
    projectId: string,
    id: string,
    text: string,
    idempotencyKey?: string,
    conclusion?: "exited" | "false_alarm" | "unconfirmed",
  ): Promise<void>;
  session(): Promise<SessionInfo>;
  /** Upload limit from the latest session read; unknown before it. */
  attachmentMaxBytes?(): number | undefined;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  projects(): Promise<readonly ProjectSummary[]>;
  /** C-675: where a full number (`SEN-C-34`) points; null when nothing has it. */
  resolveFullId?(id: string): Promise<ResolvedReference | null>;
  cards(
    projectId: string,
    filter: CardFilter,
    options?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<CardPage>;
  card(
    projectId: string,
    cardId: string,
    options?: CardReadOptions,
  ): Promise<CardDetail>;
  cardPanel?(
    projectId: string,
    cardId: string,
    panel: CardPanel,
  ): Promise<Partial<CardDetail>>;
  mentionCandidates(
    projectId: string,
    cardId: string,
  ): Promise<MentionCandidates>;
  /**
   * C-615: other cards' attachments the page names but did not receive (a
   * draft, older timeline pages); unreadable or missing numbers are left out.
   */
  attachmentRefs?(
    projectId: string,
    cardId: string,
    ids: readonly string[],
  ): Promise<AttachmentRefsResponse>;
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
  /** C-683: video limit from the latest session read; unknown before it. */
  videoMaxBytes?(): number | undefined;
  /**
   * C-683: send a video in chunks, continuing `uploadId` when given (a retry
   * resumes where the server is). Resolves with the complete upload's id,
   * which `uploadAttachment` takes instead of `file`.
   */
  uploadVideo?(
    projectId: string,
    file: Blob,
    mime: string,
    options?: {
      readonly uploadId?: string | undefined;
      readonly onStarted?: (uploadId: string) => void;
      readonly onProgress?: (received: number, size: number) => void;
    },
  ): Promise<string>;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  };
}

export class HttpCardiganClient implements CardiganClient {
  /**
   * `fetchImpl` is injected by tests; production uses the global `fetch`, which
   * sends the cookie and the `Origin` header without any help from this code.
   */
  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly streamFactory: StreamFactory = browserStream,
    retry: Partial<RetryPolicy> = {},
  ) {
    this.retry = { ...defaultRetryPolicy, ...retry };
  }

  private readonly retry: RetryPolicy;

  subscribe(projectId: string, callbacks: StreamCallbacks): () => void {
    return subscribeProject(projectId, callbacks, this.streamFactory);
  }
  private readScope: string | undefined;
  private attachmentLimit: number | undefined;
  private videoLimit: number | undefined;
  private cardsGeneration = 0;
  private cardsReadSequence = 0;
  private readonly cardPages = new Map<
    string,
    { page: CardPage; request: number }
  >();
  /**
   * C-688: the last card detail answer per exact URL with its validator. An
   * open detail revalidates; a 304 hands back the very same object.
   */
  private readonly validated = new Map<
    string,
    { readonly etag: string; readonly value: unknown }
  >();
  private clearCards() {
    this.cardsGeneration++;
    this.cardPages.clear();
    this.validated.clear();
  }
  private async conditional<T>(
    path: string,
    shape: (value: T) => T = (value) => value,
  ): Promise<T> {
    const known = this.validated.get(path);
    const answer: { etag?: string | null } = {};
    const value = await this.request<T | undefined>(
      path,
      known ? { ifNoneMatch: known.etag } : {},
      (response) => {
        answer.etag = response.headers?.get("ETag");
      },
    );
    const etag = answer.etag;
    if (value === undefined && known && etag === known.etag)
      return known.value as T;
    if (value === undefined) {
      // A 304 for a validator this client no longer holds: read in full.
      this.validated.delete(path);
      return this.conditional(path, shape);
    }
    const shaped = shape(value);
    this.validated.delete(path);
    if (etag) {
      this.validated.set(path, { etag, value: shaped });
      while (this.validated.size > 32)
        this.validated.delete(this.validated.keys().next().value as string);
    }
    return shaped;
  }
  cardPreferenceScope() {
    return this.readScope;
  }
  private cardsKey(
    project: string,
    filter: CardFilter,
    options: Readonly<Record<string, string>>,
  ) {
    return JSON.stringify([
      project,
      filter,
      Object.entries(options).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }
  cachedCards(
    project: string,
    filter: CardFilter,
    options: Readonly<Record<string, string>>,
  ) {
    return this.cardPages.get(this.cardsKey(project, filter, options))?.page;
  }
  offsiteStatus(): Promise<OffsiteStatusView | null> {
    return this.request("/api/offsite");
  }
  processHealth(): Promise<ProcessHealthView> {
    return this.request("/api/process-health");
  }
  feishuBinding(action?: "code" | "unbind") {
    return this.request<FeishuBindingView>(
      "/api/me/feishu",
      action ? { method: "POST", body: JSON.stringify({ action }) } : {},
    );
  }
  feishuSettings(): Promise<FeishuSettingsView> {
    return this.request("/api/feishu-settings");
  }
  previewFeishuSettings(
    version: string,
    change: FeishuSettingsChange,
  ): Promise<FeishuSettingsPreview> {
    return this.request("/api/feishu-settings/preview", {
      method: "POST",
      body: JSON.stringify({ version, change }),
    });
  }
  async confirmFeishuSettings(
    version: string,
    previewId: string,
    idempotencyKey: string,
    secrets?: Readonly<Partial<Record<FeishuSecretKey, string>>>,
  ): Promise<void> {
    await this.request("/api/feishu-settings/confirm", {
      method: "POST",
      body: JSON.stringify({ version, preview_id: previewId, secrets }),
      idempotencyKey,
    });
  }
  async testFeishuChannel(
    channel: FeishuChannel,
    idempotencyKey: string,
  ): Promise<FeishuTestResult> {
    // A network retry resends the same key, so the server sends at most once.
    const { result } = await this.request<{ result: FeishuTestResult }>(
      `/api/feishu-settings/test/${channel}`,
      { method: "POST", body: "{}", idempotencyKey },
    );
    return result;
  }
  async session(): Promise<SessionInfo> {
    const session = await this.request<SessionInfo>("/api/session");
    if (!session.authenticated || session.read_scope !== this.readScope)
      this.clearCards();
    this.readScope = session.authenticated ? session.read_scope : undefined;
    this.attachmentLimit =
      typeof session.attachment_max_bytes === "number" &&
      Number.isSafeInteger(session.attachment_max_bytes) &&
      session.attachment_max_bytes > 0
        ? session.attachment_max_bytes
        : undefined;
    this.videoLimit =
      typeof session.video_max_bytes === "number" &&
      Number.isSafeInteger(session.video_max_bytes) &&
      session.video_max_bytes > 0
        ? session.video_max_bytes
        : undefined;
    if (!this.readScope) clearSharedReads();
    return session;
  }
  attachmentMaxBytes() {
    return this.attachmentLimit;
  }

  videoMaxBytes() {
    return this.videoLimit;
  }

  async uploadVideo(
    projectId: string,
    file: Blob,
    mime: string,
    options: {
      readonly uploadId?: string | undefined;
      readonly onStarted?: (uploadId: string) => void;
      readonly onProgress?: (received: number, size: number) => void;
    } = {},
  ): Promise<string> {
    const base = `/api/projects/${encodeURIComponent(projectId)}/uploads`;
    let status: UploadStatus | undefined;
    if (options.uploadId) {
      // An expired or unknown upload starts over; anything else is an error.
      status = await this.request<UploadStatus>(
        `${base}/${encodeURIComponent(options.uploadId)}`,
      ).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      });
      if (status && status.size !== file.size) status = undefined;
    }
    status ??= await this.request<UploadStatus>(base, {
      method: "POST",
      body: JSON.stringify({ size: file.size, mime }),
      resend: false,
    });
    options.onStarted?.(status.upload_id);
    const path = `${base}/${encodeURIComponent(status.upload_id)}`;
    let failures = 0;
    while (!status.complete) {
      options.onProgress?.(status.received, status.size);
      const offset: number = status.received;
      const end: number = Math.min(offset + status.chunk_bytes, status.size);
      try {
        status = await this.request<UploadStatus>(`${path}?offset=${offset}`, {
          method: "PUT",
          body: file.slice(offset, end),
          contentType: "application/octet-stream",
          resend: false,
        });
        failures = 0;
      } catch (error) {
        // The server keeps what it has: ask for its offset and go on. A
        // chunk that keeps failing is reported; a retry resumes from there.
        if (error instanceof ApiError && error.status === 409)
          status = await this.request<UploadStatus>(path);
        else if (
          ++failures <= 3 &&
          (!(error instanceof ApiError) || error.status >= 500)
        ) {
          await this.retry.sleep(1000 * failures);
          status = await this.request<UploadStatus>(path);
        } else throw error;
      }
    }
    options.onProgress?.(status.size, status.size);
    return status.upload_id;
  }

  async login(password: string): Promise<void> {
    this.clearCards();
    this.readScope = undefined;
    clearSharedReads();
    await this.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async logout(): Promise<void> {
    this.clearCards();
    clearSharedReads();
    this.readScope = undefined;
    await this.request("/api/logout", { method: "POST", body: "{}" });
  }

  async projects(): Promise<readonly ProjectSummary[]> {
    const body = await this.request<{ projects: ProjectSummary[] }>(
      "/api/projects",
    );
    return body.projects;
  }

  async resolveFullId(id: string): Promise<ResolvedReference | null> {
    const body = await this.request<{ reference: ResolvedReference | null }>(
      `/api/refs/resolve?id=${encodeURIComponent(id)}`,
    );
    return body.reference;
  }

  async cards(
    projectId: string,
    filter: CardFilter,
    options: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<CardPage> {
    signal?.throwIfAborted();
    const key = this.cardsKey(projectId, filter, options);
    const request = ++this.cardsReadSequence;
    let previous = this.cardPages.get(key)?.page;
    let generation = this.cardsGeneration;
    const query = new URLSearchParams({ filter, view: "summary", ...options });
    const path = `/api/projects/${encodeURIComponent(projectId)}/cards`;
    const checkGeneration = () => {
      // Let an in-flight read finish, but do not start another stage or publish
      // its result after the page was hidden, unmounted or replaced.
      signal?.throwIfAborted();
      if (generation !== this.cardsGeneration)
        throw new ApiError(401, "unauthorized", "会话已变化，请刷新页面");
    };
    if (previous?.snapshot_version) {
      const version = await this.request<
        Pick<CardPage, "snapshot_version" | "read_scope">
      >(`${path}/version?${query}`);
      checkGeneration();
      if (version.read_scope !== previous.read_scope) {
        this.clearCards();
        this.readScope = version.read_scope;
        generation = this.cardsGeneration;
        previous = undefined;
      } else if (version.snapshot_version === previous.snapshot_version) {
        return previous;
      }
    }
    if (previous?.snapshot_version)
      query.set("since_version", previous.snapshot_version);
    const received = await this.request<
      CardPage & { delta?: boolean; card_ids?: string[] }
    >(`${path}?${query}`);
    checkGeneration();
    if (
      (previous && received.read_scope !== previous.read_scope) ||
      (received.read_scope &&
        this.readScope &&
        received.read_scope !== this.readScope)
    ) {
      this.clearCards();
      previous = undefined;
    }
    if (received.read_scope) this.readScope = received.read_scope;
    const cards = new Map(
      [...(previous?.cards ?? []), ...received.cards].map((c) => [c.id, c]),
    );
    const { delta, card_ids, ...metadata } = received;
    const page =
      delta && previous && card_ids
        ? {
            ...metadata,
            cards: card_ids.flatMap((id) =>
              cards.get(id) ? [cards.get(id) as CardListItem] : [],
            ),
          }
        : metadata;
    if ((this.cardPages.get(key)?.request ?? 0) < request) {
      this.cardPages.delete(key);
      this.cardPages.set(key, { page, request });
      while (this.cardPages.size > 32)
        this.cardPages.delete(this.cardPages.keys().next().value as string);
    }
    return page;
  }

  async card(
    projectId: string,
    cardId: string,
    options: CardReadOptions = {},
  ): Promise<CardDetail> {
    const params = new URLSearchParams();
    if (options.section) params.set("section", options.section);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.at) params.set("at", options.at);
    if (options.before) params.set("before", options.before);
    if (options.type) params.set("type", options.type);
    if (options.author) params.set("author", options.author);
    const query = params.size ? `?${params}` : "";
    return this.conditional<CardDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}${query}`,
      (detail) =>
        detail.overview
          ? {
              ...detail,
              work_items: [],
              deliveries: [],
              reviews: [],
              review_matrix: [],
              attachments: [],
            }
          : detail,
    );
  }

  cardPanel(
    projectId: string,
    cardId: string,
    panel: CardPanel,
  ): Promise<Partial<CardDetail>> {
    return this.conditional(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}?section=${panel}`,
    );
  }

  mentionCandidates(
    projectId: string,
    cardId: string,
  ): Promise<MentionCandidates> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/mentions`,
    );
  }

  attachmentRefs(
    projectId: string,
    cardId: string,
    ids: readonly string[],
  ): Promise<AttachmentRefsResponse> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/attachment-refs?ids=${ids.map(encodeURIComponent).join(",")}`,
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
  releaseNotes(projectId: string): Promise<ReleaseNotesData> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/release-notes`,
    );
  }
  writeReleaseNote(
    projectId: string,
    input: WriteReleaseNoteInput,
    idempotencyKey: string,
  ): Promise<WriteReleaseNoteResult> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/release-notes`,
      { method: "POST", body: JSON.stringify(input), idempotencyKey },
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
  executionDiagnostics(projectId: string): Promise<ExecutionDiagnosticsData> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/execution/diagnostics`,
    );
  }
  machines(projectId: string): Promise<{ machines: readonly MachineView[] }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/machines`,
    );
  }
  machine(
    projectId: string,
    machineId: string,
  ): Promise<{ machine: MachineView }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/machines/${encodeURIComponent(machineId)}`,
    );
  }
  checkMachine(
    projectId: string,
    machineId: string,
    idempotencyKey: string,
  ): Promise<{ check: MachineCheckJob }> {
    // The key identifies the click; it is never resent (see the interface).
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/machines/${encodeURIComponent(machineId)}/check`,
      { method: "POST", body: "{}", idempotencyKey, resend: false },
    );
  }
  machineCheck(
    projectId: string,
    machineId: string,
    checkId: string,
  ): Promise<{ check: MachineCheckJob }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/machines/${encodeURIComponent(machineId)}/checks/${encodeURIComponent(checkId)}`,
    );
  }
  setMachineDrain(
    projectId: string,
    machineId: string,
    drain: boolean,
    idempotencyKey: string,
  ): Promise<{ machine_id: string; status: string }> {
    // Not resent: a late duplicate could undo a later opposite action.
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/machines/${encodeURIComponent(machineId)}/${drain ? "drain" : "resume"}`,
      { method: "POST", body: "{}", idempotencyKey, resend: false },
    );
  }
  cancelMachineReservation(
    projectId: string,
    machineId: string,
    reservationId: string,
    reason: string,
  ): Promise<{ reservation_id: string; released_runs: number }> {
    // Not resent: a lost reply is followed by a fresh read of the machine.
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/machines/${encodeURIComponent(machineId)}/reservations/${encodeURIComponent(reservationId)}/cancel`,
      { method: "POST", body: JSON.stringify({ reason }), resend: false },
    );
  }
  createWorkerWizard(
    projectId: string,
    input: WorkerWizardInput,
  ): Promise<{ wizard: WorkerWizardView }> {
    // No automatic retry: wizard steps are not keyed on the server, so a
    // failed reply is followed by a fresh read instead.
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/worker-wizards`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  pairWorkerDevice(
    projectId: string,
    input: { readonly code: string; readonly run_limit: number },
  ): Promise<{ wizard: WorkerWizardView; device: WorkerPairingDevice }> {
    // Never resent: a code works once, so a lost reply is not retried.
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/worker-wizards/pairing`,
      { method: "POST", body: JSON.stringify(input), resend: false },
    );
  }
  capabilityGuides(
    projectId: string,
    machineId: string,
  ): Promise<CapabilityGuidesView> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/capability-guides?machine=${encodeURIComponent(machineId)}`,
    );
  }
  async setCapabilityGuide(
    projectId: string,
    target: CapabilityGuideTarget,
    note: string,
  ): Promise<void> {
    // Not resent automatically: the page reads the notes back after a failure.
    await this.request(
      `/api/projects/${encodeURIComponent(projectId)}/capability-guides`,
      {
        method: "PUT",
        body: JSON.stringify({ ...target, usage_note: note }),
      },
    );
  }
  async deleteCapabilityGuide(
    projectId: string,
    target: CapabilityGuideTarget,
  ): Promise<void> {
    try {
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/capability-guides`,
        { method: "DELETE", body: JSON.stringify(target) },
      );
    } catch (error) {
      // Already gone (an earlier attempt whose reply was lost): done.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  workerWizardDefaults(
    projectId: string,
  ): Promise<{ defaults: WorkerWizardDefaults }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/worker-wizards/defaults`,
    );
  }
  workerWizard(
    projectId: string,
    wizardId: string,
  ): Promise<{ wizard: WorkerWizardView }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/worker-wizards/${encodeURIComponent(wizardId)}`,
    );
  }
  workerWizardAction(
    projectId: string,
    wizardId: string,
    action: WorkerWizardAction,
  ): Promise<{ wizard: WorkerWizardView } | { cancelled: true }> {
    const { kind, ...body } = action;
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/worker-wizards/${encodeURIComponent(wizardId)}/${kind}`,
      { method: "POST", body: JSON.stringify(body) },
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
  startAssignment(
    projectId: string,
    assignmentId: string,
    restart: boolean,
    idempotencyKey: string,
  ): Promise<{ readonly run_id: string }> {
    return this.write(
      projectId,
      `execution/assignments/${encodeURIComponent(assignmentId)}/start`,
      restart ? { restart: true } : {},
      idempotencyKey,
    ) as Promise<{ readonly run_id: string }>;
  }
  stopAssignment(
    projectId: string,
    assignmentId: string,
    idempotencyKey: string,
  ): Promise<AssignmentStopResult> {
    return this.write(
      projectId,
      `execution/assignments/${encodeURIComponent(assignmentId)}/stop`,
      {},
      idempotencyKey,
    ) as Promise<AssignmentStopResult>;
  }
  assignmentDiff(
    projectId: string,
    assignmentId: string,
  ): Promise<AssignmentDiff> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/execution/assignments/${encodeURIComponent(assignmentId)}/diff`,
    );
  }
  decisionHistory(
    projectId: string,
    filters: Readonly<Record<string, string>>,
    cursor?: string,
  ): Promise<DecisionHistoryPage> {
    const query = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v),
    );
    if (cursor) query.set("cursor", cursor);
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
  async setHumanCardTemplates(
    projectId: string,
    changes: Readonly<Record<string, boolean>>,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { human_card_templates: changes },
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
    storySummaryEntryId?: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/mark-done`,
      {
        result,
        attachments,
        ...(storySummaryEntryId
          ? { story_summary_entry_id: storySummaryEntryId }
          : {}),
      },
      idempotencyKey,
    );
  }
  async confirmStoryProposal(
    projectId: string,
    cardId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<StoryConfirmation> {
    return (await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/story-confirm`,
      { version },
      idempotencyKey,
    )) as StoryConfirmation;
  }
  async setMergeConfirmSnoozeDefault(
    projectId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { merge_confirm_snooze_default_minutes: minutes },
      idempotencyKey,
    );
  }
  async setMergeConfirmStallAfter(
    projectId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { merge_confirm_stall_after_minutes: minutes },
      idempotencyKey,
    );
  }
  async setReviewMaxRounds(
    projectId: string,
    kind: "review" | "independent",
    rounds: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      kind === "review"
        ? { review_max_rounds: rounds }
        : { independent_review_max_rounds: rounds },
      idempotencyKey,
    );
  }
  async setIndependentReviewLimitDelegation(
    projectId: string,
    enabled: boolean,
    max: number | null,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      {
        independent_review_limit_delegation: enabled,
        independent_review_limit_delegation_max: max,
      },
      idempotencyKey,
    );
  }
  async setMergeConfirmSnoozeMax(
    projectId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { merge_confirm_snooze_max_minutes: minutes },
      idempotencyKey,
    );
  }
  async setCrossCardRead(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { cross_card_read: enabled },
      idempotencyKey,
    );
  }
  async setAutoMerge(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { auto_merge: enabled ? "on" : "off" },
      idempotencyKey,
    );
  }
  async setAutoMergePaused(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { auto_merge_paused: enabled },
      idempotencyKey,
    );
  }
  async setPmConfirmHumanDecidedMerges(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { pm_confirm_human_decided_merges: enabled },
      idempotencyKey,
    );
  }
  async setPmConfirmRoleRuleImplementations(
    projectId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      "preferences",
      { pm_confirm_role_rule_implementations: enabled },
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
  async setSystemRules(
    projectId: string,
    input: SystemRulesPreferences,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(projectId, "preferences", input, idempotencyKey);
  }
  async setManualAssign(
    projectId: string,
    workItemId: string,
    enabled: boolean,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `work-items/${encodeURIComponent(workItemId)}/manual-assign`,
      { manual_assign: enabled },
      idempotencyKey,
    );
  }
  async replacePrimaryWorkItem(
    projectId: string,
    workItemId: string,
    input: PrimaryReplacementInput,
    idempotencyKey: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `work-items/${encodeURIComponent(workItemId)}/replace-primary`,
      input,
      idempotencyKey,
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
  launchSettings(): Promise<LaunchSettingsView> {
    return this.request("/api/launch-settings");
  }
  previewLaunchChange(
    version: string,
    change: LaunchChange,
  ): Promise<LaunchPreview> {
    return this.request("/api/launch-settings/preview", {
      method: "POST",
      body: JSON.stringify({ version, change }),
    });
  }
  async confirmLaunchChange(
    version: string,
    previewId: string,
    idempotencyKey: string,
    secrets?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.request("/api/launch-settings/confirm", {
      method: "POST",
      body: JSON.stringify({ version, preview_id: previewId, secrets }),
      idempotencyKey,
    });
  }
  launchModels(version: string, provider: string): Promise<LaunchModelList> {
    return this.request("/api/launch-settings/models", {
      method: "POST",
      body: JSON.stringify({ version, provider }),
    });
  }
  checkLaunchModel(
    version: string,
    provider: string,
    model: string,
  ): Promise<LaunchModelCheck> {
    return this.request("/api/launch-settings/model-check", {
      method: "POST",
      body: JSON.stringify({ version, provider, model }),
    });
  }
  startProviderCheck(
    version: string,
    provider: string,
  ): Promise<LaunchCheckStarted> {
    return this.request("/api/launch-settings/checks", {
      method: "POST",
      body: JSON.stringify({ version, provider, mode: "online" }),
    });
  }
  startLaunchCheck(
    version: string,
    profile: string,
    mode: LaunchProfileCheck["mode"],
  ): Promise<LaunchCheckStarted> {
    return this.request("/api/launch-settings/checks", {
      method: "POST",
      body: JSON.stringify({ version, profile, mode }),
    });
  }
  employeeOptions(projectId: string): Promise<EmployeeOptions> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/employees/options`,
    );
  }
  createEmployee(
    projectId: string,
    input: CreateEmployeeInput,
    idempotencyKey: string,
  ): Promise<CreatedEmployee> {
    return this.write(
      projectId,
      "employees",
      input,
      idempotencyKey,
    ) as Promise<CreatedEmployee>;
  }
  updateEmployee(
    projectId: string,
    employeeId: string,
    patch: EmployeePatch,
    idempotencyKey: string,
  ): Promise<CreatedEmployee> {
    return this.write(
      projectId,
      `employees/${encodeURIComponent(employeeId)}/update`,
      patch,
      idempotencyKey,
    ) as Promise<CreatedEmployee>;
  }
  previewRoleDocument(
    projectId: string,
    markdown: string,
  ): Promise<RoleDocumentPreview> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/role-document/preview`,
      { method: "POST", body: JSON.stringify({ markdown }) },
    );
  }
  applyRoleDocument(
    projectId: string,
    markdown: string,
    snapshot: string,
    idempotencyKey: string,
  ): Promise<RoleDocumentPreview> {
    return this.write(
      projectId,
      "role-document/apply",
      { markdown, snapshot },
      idempotencyKey,
    ) as Promise<RoleDocumentPreview>;
  }
  async launchProfileNames(): Promise<readonly string[]> {
    const { profiles } = await this.request<{ profiles: readonly string[] }>(
      "/api/launch-settings/profiles",
    );
    return profiles;
  }
  exportRole(projectId: string, roleId: string): Promise<{ markdown: string }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(roleId)}/export`,
    );
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
  async needsYou(projectId: string, invalidation?: string): Promise<NeedsPage> {
    return this.readNeeds<NeedsPage>(projectId, "", invalidation, true);
  }
  needsYouCounts(
    projectId: string,
    invalidation?: string,
  ): Promise<NeedsCounts> {
    return this.readNeeds<NeedsCounts>(
      projectId,
      "/counts",
      invalidation,
      true,
    );
  }
  needsYouSection(
    projectId: string,
    section: NeedsTab,
    invalidation?: string,
  ): Promise<NeedsPage> {
    return this.readNeeds<NeedsPage>(
      projectId,
      `?section=${encodeURIComponent(section)}`,
      invalidation,
      false,
    );
  }
  private async readNeeds<T>(
    projectId: string,
    suffix: string,
    invalidation: string | undefined,
    retain: boolean,
  ): Promise<T> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/needs-you${suffix}`;
    const load = () => this.request<T>(path);
    if (!this.readScope || invalidation === undefined) {
      clearSharedReads();
      return load();
    }
    // Local event histories and connection counts are not comparable across
    // tabs. Revalidate through the authenticated project revision endpoint.
    let version: { read_scope: string; revision: string; at: string };
    try {
      version = await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/needs-you/version`,
      );
    } catch (error) {
      clearSharedReads();
      throw error;
    }
    if (
      !version.read_scope ||
      !version.revision ||
      !Number.isFinite(Date.parse(version.at))
    ) {
      clearSharedReads();
      throw new ApiError(
        409,
        "read_context_changed",
        "读取上下文已变化，请重试",
      );
    }
    const cached = await sharePendingRead(
      version.read_scope,
      projectId,
      `${version.revision}:${suffix}`,
      async () => {
        let at = version.at;
        const page = await this.request<T>(path, {}, (response) => {
          if (
            response.headers.get("X-Cardigan-Read-Scope") !== version.read_scope
          ) {
            clearSharedReads();
            throw new ApiError(
              409,
              "read_context_changed",
              "登录状态已变化，请重新读取",
            );
          }
          at = response.headers.get("X-Cardigan-Read-At") ?? version.at;
        });
        return { page, at };
      },
      retain,
    );
    return needsAges(cached.page, cached.at, version.at);
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
  async confirmSourceUnrelated(
    projectId: string,
    id: string,
    cardId: string,
    sourceId: string,
    version: number,
    key: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `decisions/${encodeURIComponent(id)}/source-unrelated`,
      { card_id: cardId, source_decision_id: sourceId, version },
      key,
    );
  }
  async recordDecision(
    projectId: string,
    id: string,
    option: string,
    quote: string,
    idempotencyKey: string = crypto.randomUUID(),
    delegateFuture = false,
    snoozeUntil?: string,
    mergeOverrideReason?: string,
    mergeOverrideFollowUp?: boolean,
  ): Promise<void> {
    await this.write(
      projectId,
      `decisions/${encodeURIComponent(id)}/resolve`,
      {
        option,
        raw_quote: quote,
        ...(delegateFuture ? { delegate_future: true } : {}),
        ...(snoozeUntil !== undefined ? { snooze_until: snoozeUntil } : {}),
        ...(mergeOverrideReason !== undefined
          ? { merge_override_reason: mergeOverrideReason }
          : {}),
        ...(mergeOverrideFollowUp ? { merge_override_follow_up: true } : {}),
      },
      idempotencyKey,
    );
  }
  async applySuggestion(
    projectId: string,
    id: string,
    option: string,
    quote: string,
    idempotencyKey: string = crypto.randomUUID(),
    progressToken?: string,
    suggestionVersion?: number,
  ): Promise<void> {
    await this.write(
      projectId,
      `decisions/${encodeURIComponent(id)}/resolve`,
      {
        option,
        raw_quote: quote,
        via_suggestion: true,
        suggestion_progress_token: progressToken,
        suggestion_version: suggestionVersion,
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
  async cancelAction(
    projectId: string,
    id: string,
    reason: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `human-actions/${encodeURIComponent(id)}/cancel`,
      { reason },
      idempotencyKey,
    );
  }
  async setActionMergeBlocking(
    projectId: string,
    id: string,
    input: MergeBlockingInput,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `human-actions/${encodeURIComponent(id)}/merge-blocking`,
      input,
      idempotencyKey,
    );
  }
  async reassignAction(
    projectId: string,
    id: string,
    executor: "owner" | "operator",
    reason: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `human-actions/${encodeURIComponent(id)}/reassign`,
      { executor, reason },
      idempotencyKey,
    );
  }
  async completeAction(
    projectId: string,
    id: string,
    text: string,
    idempotencyKey: string = crypto.randomUUID(),
    conclusion?: "exited" | "false_alarm" | "unconfirmed",
  ): Promise<void> {
    await this.write(
      projectId,
      `human-actions/${encodeURIComponent(id)}/complete`,
      { text, conclusion },
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
    input:
      | CardUpdateInput
      | { hold: Pick<CardHold, "reason" | "resume_condition"> | null },
    idempotencyKey = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/update`,
      input,
      idempotencyKey,
    );
  }
  createCard(
    projectId: string,
    input: CreateCardInput,
    idempotencyKey: string,
  ): Promise<CreatedCard> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/cards`,
      { method: "POST", body: JSON.stringify(input), idempotencyKey },
    );
  }
  async cancelCard(
    projectId: string,
    cardId: string,
    reason: string,
    idempotencyKey = crypto.randomUUID(),
    children?: StoryChildChoice,
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/cancel`,
      { reason, ...(children ? { story_children: children } : {}) },
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
  async mergeBatch(
    projectId: string,
    batchId: string,
  ): Promise<{ batch: MergeBatchView; probes: readonly MergeBatchView[] }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/merge-batches/${encodeURIComponent(batchId)}`,
    );
  }
  async setMergeSolo(
    projectId: string,
    cardId: string,
    solo: boolean,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<void> {
    await this.write(
      projectId,
      `cards/${encodeURIComponent(cardId)}/merge-solo`,
      { solo },
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
    init: {
      method?: string;
      body?: string | Blob;
      /** Content type of a non-JSON body (C-683 upload chunks). */
      contentType?: string;
      idempotencyKey?: string;
      /**
       * C-511: whether a transport failure may be resent automatically. By
       * default keyed writes are; an operation the server does not dedupe
       * sends its key as an identifier only (`resend: false`).
       */
      resend?: boolean;
      /** C-688: a 304 answer then resolves to `undefined`. */
      ifNoneMatch?: string;
    } = {},
    observe?: (response: Response) => void,
  ): Promise<T> {
    const method = init.method ?? "GET";
    const send = () =>
      this.fetchImpl(path, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": init.contentType ?? "application/json" }),
          ...(init.idempotencyKey === undefined
            ? {}
            : { "Idempotency-Key": init.idempotencyKey }),
          ...(init.ifNoneMatch === undefined
            ? {}
            : { "If-None-Match": init.ifNoneMatch }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    const { response, lostReply } = await this.sendWithRetry(
      send,
      init.resend ?? isRetryableRequest(method, init.idempotencyKey),
      method === "GET" || method === "HEAD",
    );
    if (response.status === 304 && init.ifNoneMatch !== undefined) {
      observe?.(response);
      return undefined as T;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.clearCards();
        this.readScope = undefined;
        clearSharedReads();
      }
      const error = await toApiError(response, method, path);
      throw lostReply
        ? new ApiError(
            error.status,
            error.code,
            error.message,
            true,
            error.details,
          )
        : error;
    }
    observe?.(response);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /**
   * C-250: retries 502/503 and refused connections for reads and keyed writes.
   * Every attempt sends the identical request, so the key never changes.
   * `lostReply` records that some attempt failed without a reply (the server
   * may have applied it), so a final 502/503 cannot prove nothing happened.
   *
   * C-775: a read the read pool refused as overloaded (503 `read_timeout` /
   * `read_busy`) follows its own schedule (by default not retried at all) and
   * never raises the "服务正在更新" notice; a restart keeps the C-250
   * schedule. Writes never take the overload branch.
   */
  private async sendWithRetry(
    send: () => Promise<Response>,
    retryable: boolean,
    read: boolean,
  ): Promise<{ response: Response; lostReply: boolean }> {
    const { delaysMs, readOverloadDelaysMs, sleep, notice } = this.retry;
    let end: (() => void) | undefined;
    let lostReply = false;
    let restarts = 0;
    let overloads = 0;
    try {
      for (;;) {
        const canRetry = retryable && restarts < delaysMs.length;
        let response: Response;
        try {
          response = await send();
        } catch (error) {
          if (!canRetry || !(error instanceof TypeError)) throw error;
          lostReply = true;
          end ??= notice.begin();
          await sleep(delaysMs[restarts++] ?? 0);
          continue;
        }
        if (!retryable || !SERVICE_UPDATING_STATUSES.has(response.status))
          return { response, lostReply };
        if (read && (await isOverloadResponse(response))) {
          if (overloads >= readOverloadDelaysMs.length)
            return { response, lostReply };
          await sleep(readOverloadDelaysMs[overloads++] ?? 0);
          continue;
        }
        if (!canRetry) return { response, lostReply };
        end ??= notice.begin();
        await sleep(delaysMs[restarts++] ?? 0);
      }
    } finally {
      end?.();
    }
  }
}

/** C-775: whether a 503 carries one of the read pool's overload codes. */
async function isOverloadResponse(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as ErrorBody;
    const code = body.error?.code;
    return code !== undefined && READ_OVERLOAD_CODES.has(code);
  } catch {
    // A proxy's HTML 503 is a restart, not the read pool.
    return false;
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
  return new ApiError(
    response.status,
    code,
    message,
    false,
    body.error?.details,
  );
}

/**
 * Server messages written for CLI users may name preference keys
 * (`cardigan preference set ...`); the Web points at the settings label instead.
 */
function webErrorMessage(message: string): string {
  return (
    message
      .replace(
        /^(暂缓到期时间距现在不能超过 \d+ 分钟)（merge-confirm-snooze-max）/u,
        "$1（可在项目设置的“合并确认最长暂缓时长”中调整）",
      )
      .replace(/^Attachment exceeds (\d+(?:\.\d)? MiB)$/u, "附件超过 $1")
      // C-683: video limit and the server's format check.
      .replace(/^Video exceeds (\d+(?:\.\d)? MiB)$/u, "视频超过 $1")
      .replace(
        /^File content is not (\w+) video; .*$/u,
        "文件内容与扩展名不符，不是 $1 视频",
      )
  );
}

/** Human-readable Chinese explanation of a failed request. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // The login endpoint answers 401 for a wrong password; every other 401 is a
    // session that expired or was revoked by a password change.
    if (error.code === "invalid_credentials") return "密码不对。";
    if (error.status === 401) return "会话已失效，请重新登录。";
    if (error.status === 429) return "尝试次数太多，请稍后再试。";
    if (error.status === 403) {
      if (error.code === "owner_required")
        return webErrorMessage(error.message);
      if (["origin_required", "origin_rejected"].includes(error.code))
        return "请求被拒绝（来源校验未通过）。";
      if (["unauthorized", "forbidden_tool"].includes(error.code))
        return "没有权限执行此操作。";
      return "请求被拒绝，请检查操作权限和当前状态。";
    }
    // C-775: checked before the restart copy, which shares status 503.
    if (isReadOverload(error)) return "服务繁忙，读取超时，请稍后重试。";
    if (SERVICE_UPDATING_STATUSES.has(error.status))
      return "服务正在更新，暂时没有恢复，请几秒后再试。";
    return `请求失败：${webErrorMessage(error.message)}`;
  }
  if (error instanceof TypeError) {
    return "连不上 Workbench 服务，可能正在更新，请几秒后再试。";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Only transport failures and 5xx responses leave a write's outcome uncertain. */
export function describeWriteError(
  error: unknown,
  uncertainMessage = "操作可能已经成功，保留原内容重试不会重复提交。",
): string {
  // C-250: during a restart the proxy answers 502/503 without reaching the
  // server, so the copy agreed under Q-279 says the write did not take effect.
  // A 502 can, rarely, also follow a commit when the old process is killed
  // before replying; keyed writes stay safe to click again either way. When an
  // earlier retry lost its reply the write may have landed, so say "maybe".
  if (error instanceof ApiError && SERVICE_UPDATING_STATUSES.has(error.status))
    return error.outcomeUncertain
      ? `服务正在更新，暂时没有恢复。${uncertainMessage}`
      : "服务正在更新，暂时没有恢复，操作没有生效，请几秒后再点一次。";
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

export interface AuthorPrecheck {
  readonly attempt_id: string;
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
  readonly updated_at?: string;
  readonly summary?: string;
  readonly log_ref?: string;
}

export interface ExecutionDiagnosticsData {
  readonly available?: boolean;
  readonly expires_at?: string;
  readonly configuration: readonly {
    readonly profile: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly sessions: readonly {
    readonly assignment_id: string;
    readonly cause: string;
    readonly action: string;
    readonly evidence: readonly string[];
  }[];
}
