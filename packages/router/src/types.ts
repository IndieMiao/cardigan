import type {
  Assignment,
  AssignmentId,
  Card,
  CardId,
  CardTemplate,
  Decision,
  Delivery,
  Employee,
  Event,
  EventId,
  HumanAction,
  JsonValue,
  ProjectId,
  ProjectPreferences,
  Review,
  RoleId,
  RoleReference,
  Run,
  TimelineEntry,
  WorkItem,
  WorkItemId,
} from "@cardigan/domain";

/**
 * M3.1 routing types.
 *
 * The router is pure: it reads the event and a project snapshot, and returns
 * the recipients and notification kinds of M3 plan §5 M3.1 (`docs/plans/
 * phase-1-m3.md`). The notification state machine and the doorbell-triggered
 * Run kinds live in M3.2 (domain); the router only describes what should be
 * delivered, so it defines those shapes here until M3.2 lands.
 */

/** Who receives a notification (§6.4). */
export type RecipientKind = "assignment" | "pm_ops" | "pm_office" | "needs_you";

export interface Recipient {
  readonly kind: RecipientKind;
  /** Set only for `kind: "assignment"`. */
  readonly assignment_id?: AssignmentId | undefined;
}

/** What the recipient is being told, used for merging and for the inbox. */
export type NotificationKind =
  | "assignment"
  | "comment"
  | "instruction"
  | "delivery"
  | "review"
  | "decision"
  | "dependency"
  | "completion"
  | "human_action"
  | "run_attention"
  | "escalation"
  | "needs_you";

/**
 * Which rule produced the notification. Every §6.4 row, §6.5 case, §7.2
 * escalation and §3.3 pipeline condition has its own id, so a test can name it.
 */
export type RuleId =
  // §6.4 rows
  | "6.4/work-item comment"
  | "6.4/card comment without mention"
  | "6.4/instruction"
  | "6.4/work item assigned"
  | "6.4/delivery submitted"
  | "6.4/review passed"
  | "6.4/review rejected"
  | "6.4/review conditional"
  | "6.4/decision requested"
  | "6.4/decision resolved"
  | "6.4/dependency completed"
  | "6.4/all required work items passed"
  | "6.4/completion request"
  | "6.4/human action requested"
  | "6.4/human action completed"
  | "6.4/bell delivery failed"
  | "6.4/run finished without output"
  | "6.4/agent idle without finish_run"
  | "6.4/runtime lost"
  | "6.4/merge conflicted"
  | "6.4/merge changes requested"
  | "6.4/merge check finished"
  | "6.4/card merged"
  | "6.4/merge failed"
  | "6.4/reconcile finding"
  // §6.5 mention cases
  | "6.5/single assignment for the role"
  | "6.5/no assignment for the role"
  | "6.5/several assignments for the role"
  | "6.5/explicit assignment or work item"
  | "6.5/single assignment for the employee"
  | "6.5/no assignment for the employee"
  | "6.5/several assignments for the employee"
  // §7.2 escalations
  | "7.2/work conflict or priority contention"
  | "7.2/delivery rejected twice"
  | "7.2/delivery does not match the requirement"
  | "7.2/decide whether to pause"
  | "7.2/unhandled exception"
  // §7.3 information levels
  | "7.3/agent execution failed";

export interface RoutedNotification {
  readonly recipient: Recipient;
  readonly kind: NotificationKind;
  readonly rule: RuleId;
  readonly event_id: EventId;
  readonly seq: number;
  readonly card_id?: CardId | undefined;
  readonly work_item_id?: WorkItemId | undefined;
  /** M4.4 maps a conflict notification to a fix Run. */
  readonly run_kind?: Run["kind"];
  /** One short line for the inbox and the merged bell summary. */
  readonly summary: string;
}

/** Something the caller must check or persist after routing. */
export interface RouteCheck {
  readonly rule: RuleId;
  readonly card_id?: CardId | undefined;
  readonly detail: string;
}

/** A mention the router could not resolve; the speaker must clarify. */
export interface RouteProblem {
  readonly rule: RuleId;
  readonly code:
    | "unknown_mention"
    | "ambiguous_role_mention"
    | "ambiguous_employee_mention"
    | "mentioned_work_item_unassigned";
  readonly detail: string;
}

export interface RouteResult {
  readonly notifications: readonly RoutedNotification[];
  readonly checks: readonly RouteCheck[];
  readonly problems: readonly RouteProblem[];
}

/**
 * The project state the router may read. It is deliberately a snapshot of the
 * domain entities the rules need, not the live `CommandState`.
 */
export interface RouterSnapshot {
  readonly card_templates?: readonly CardTemplate[];
  readonly project_id: ProjectId;
  readonly project_preferences?: readonly ProjectPreferences[];
  readonly cards: readonly Card[];
  readonly work_items: readonly WorkItem[];
  readonly assignments: readonly Assignment[];
  readonly employees?: readonly Employee[];
  readonly roles?: readonly RoleReference[];
  readonly deliveries: readonly Delivery[];
  readonly reviews: readonly Review[];
  readonly decisions: readonly Decision[];
  readonly human_actions: readonly HumanAction[];
  readonly runs: readonly Run[];
  readonly timeline: readonly TimelineEntry[];
  /** The project's events; rules read the ones a Run produced (payload.run_id). */
  readonly events: readonly Event[];
  /** Roles a card template designates as its reviewer; defaults to `pm`. */
  readonly completion_reviewer_roles?: readonly RoleId[] | undefined;
}

export interface RouteInput {
  readonly event: Event;
  readonly snapshot: RouterSnapshot;
}

export const recipient = {
  assignment: (assignment_id: AssignmentId): Recipient => ({
    kind: "assignment",
    assignment_id,
  }),
  pm_ops: (): Recipient => ({ kind: "pm_ops" }),
  pm_office: (): Recipient => ({ kind: "pm_office" }),
  needs_you: (): Recipient => ({ kind: "needs_you" }),
} as const;

/** Read the routing payload of an event without trusting its shape. */
export const payloadObject = (payload: JsonValue): Record<string, JsonValue> =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

export const payloadString = (
  payload: JsonValue,
  key: string,
): string | undefined => {
  const value = payloadObject(payload)[key];
  return typeof value === "string" ? value : undefined;
};

export const payloadStrings = (
  payload: JsonValue,
  key: string,
): readonly string[] => {
  const value = payloadObject(payload)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
};
