import type {
  Assignment,
  AssignmentId,
  Attachment,
  AttachmentId,
  Card,
  CardId,
  CardTemplate,
  CommandState,
  Cursor,
  Decision,
  DecisionId,
  Delivery,
  DeliveryId,
  EmployeeRepository,
  Event,
  EventRepository,
  HumanAction,
  HumanActionId,
  Machine,
  MachineId,
  MemberRepository,
  ProjectId,
  ProjectPreferences,
  Repository,
  Result,
  Review,
  ReviewId,
  RoleReference,
  Run,
  RunId,
  TimelineEntry,
  TimelineEntryId,
  ToolName,
  TransactionContext,
  WorkItem,
  WorkItemId,
} from "@cardigan/domain";

/**
 * The token row as the MCP layer sees it.
 *
 * Declared here instead of importing the store's type so `mcp-server` depends
 * only on `domain` (§20.2); the store's `TokenRecord` satisfies this shape.
 */
export interface McpToken {
  readonly id: string;
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly role_version: number;
  readonly allowed_tools: readonly ToolName[];
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** C-635: an activity time waiting to be written (the store's shape). */
export interface McpDeferredActivity {
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly at: string;
  readonly token_id?: string;
}

export interface McpUpdates {
  readonly events: readonly Event[];
  readonly timeline: readonly TimelineEntry[];
  readonly latest_seq: number;
}

export interface McpAckResult {
  readonly acked_seq: number;
  readonly changed: boolean;
}

/** A repository as seen inside a read transaction: reads only. */
export type McpReadRepository<Entity, Key> = Pick<
  Repository<Entity, Key>,
  "get" | "list"
>;

/** What a read transaction hands to its callback. */
export interface McpReadContext {
  readonly cardSources?: (
    project: ProjectId,
    card: CardId,
  ) => Pick<CommandState, "timeline" | "attachments">;
  readonly projectMergeEvents?: (project: ProjectId) => readonly Event[];
  readonly dependencyEvents?: (project: ProjectId) => readonly Event[];
  /** Trusted host deployment records of a SHA in the control plane's other projects. */
  readonly platformDeployments?: (
    project: ProjectId,
    sha: string,
  ) => readonly Event[];
  readonly read_machine_placement?: import("@cardigan/domain").ReadMachinePlacement;
  readonly test_review_trust?: import("@cardigan/domain").TestReviewTrust;
  readonly cachedCommandState?: (
    project: ProjectId,
    build: () => CommandState,
  ) => CommandState;
  readonly members?: Pick<MemberRepository, "get" | "list">;
  readonly project_preferences?: McpReadRepository<
    ProjectPreferences,
    ProjectId
  >;
  readonly card_templates?: McpReadRepository<
    CardTemplate,
    Pick<CardTemplate, "id" | "version">
  >;
  readonly employees?: Pick<
    EmployeeRepository,
    "get" | "list" | "assignmentActivity"
  >;
  readonly cards: McpReadRepository<Card, CardId>;
  readonly work_items: McpReadRepository<WorkItem, WorkItemId>;
  readonly assignments: McpReadRepository<Assignment, AssignmentId>;
  readonly runs: McpReadRepository<Run, RunId>;
  readonly timeline: McpReadRepository<TimelineEntry, TimelineEntryId>;
  readonly deliveries: McpReadRepository<Delivery, DeliveryId>;
  readonly reviews: McpReadRepository<Review, ReviewId>;
  readonly decisions: McpReadRepository<Decision, DecisionId>;
  readonly human_actions: McpReadRepository<HumanAction, HumanActionId>;
  readonly attachments: McpReadRepository<Attachment, AttachmentId>;
  readonly roles: McpReadRepository<
    RoleReference,
    Pick<RoleReference, "role_id" | "role_version">
  >;
  readonly machines: McpReadRepository<Machine, MachineId>;
  readonly cursors: McpReadRepository<
    Cursor,
    Pick<Cursor, "assignment_id" | "card_id">
  >;
  readonly events: Pick<EventRepository, "listAfter"> & {
    listStreams?(project: ProjectId): CommandEventStreams;
  };
  /** C-639: process-wide scope; absent keeps the whole-history state. */
  readonly command_state_scope?: "full" | "hot" | "lean" | "slim";
  readonly hot_state_hints?: {
    eventCards(
      project: ProjectId,
      ids: readonly string[],
    ): ReadonlyMap<string, string | undefined>;
    liveNotificationCards(project: ProjectId): readonly string[];
    /** C-649: project-stream subjects of live notifications. */
    liveNotificationEvents?(project: ProjectId): readonly string[];
  };
}

/** Bulk streams; `ofTypes` is the Store log's per-type subset (C-639). */
export type CommandEventStreams = ReadonlyMap<string, readonly Event[]> & {
  ofTypes?(types: ReadonlySet<string>): ReadonlyMap<string, readonly Event[]>;
};

/**
 * Everything the MCP layer needs from the control plane's store.
 *
 * A structural port: the SQLite `Store` from `@cardigan/store` satisfies it
 * without knowing about MCP, and apps/server decides which implementation to
 * pass in. Only `domain` types appear in this surface.
 */
export interface McpBackend {
  /** Host quota journal: callback and debit commit atomically before response. */
  withCheckLogBudget?<T>(
    key: {
      project_id: ProjectId;
      card_id: CardId;
      attempt_id: string;
      assignment_id: AssignmentId;
    },
    maximum: number,
    consume: (
      remaining: number,
      tx: McpReadContext,
    ) => { bytes: number; value: T },
  ): T;
  /** Host metadata; read on the same connection as the active command transaction. */
  getProject?(project_id: ProjectId):
    | {
        readonly repo_path: string | null;
        readonly base_branch: string | null;
        /** C-674: the project's code (`CDG`); null before one is registered. */
        readonly code?: string | null;
      }
    | undefined;
  /** Cache lookup, command and response recording share one write transaction. */
  runIdempotent<T>(
    params: {
      readonly project_id: ProjectId;
      readonly assignment_id: AssignmentId;
      readonly key: string;
      readonly request: unknown;
    },
    operation: (tx: TransactionContext) => T,
  ): Result<{ readonly value: T; readonly replayed: boolean }>;
  /** Resolve a token by its stored hash; revoked tokens resolve to `undefined`. */
  verifyResourceRead?(
    id: string,
    key: string,
    challenge: string,
    proof: string,
  ): McpToken | undefined;
  readonly runResources?: { signState(data: string): string };
  verifyToken(token: string): McpToken | undefined;
  /**
   * M3.2: record the last authenticated MCP call for the watchdog (§3.3).
   * Optional so pure routing tests can use a bare backend.
   */
  touchAssignmentActivity?(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    at?: string,
    /** C-600: the request's Token; another launch's Token is not activity. */
    token_id?: string,
  ): boolean;
  /** C-600: record the session's native `tools/list` or a premature tool call. */
  advanceMcpHandshake?(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    observed: "tools_listed" | "tool_called",
    key_sha256?: string,
    token_id?: string,
  ): string | undefined;
  /**
   * C-635: the hot-path variant of `advanceMcpHandshake`. It never waits for
   * another process's write lock; `persisted: false` means the returned state
   * was decided but must still be written.
   */
  tryAdvanceMcpHandshake?(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    observed: "tools_listed" | "tool_called",
    key_sha256?: string,
    token_id?: string,
  ): { readonly state: string | undefined; readonly persisted: boolean };
  /** C-635: the store's clock, which stamps MCP activity. */
  now?(): string;
  /** C-635: run `operation` without waiting for another process's write lock. */
  withoutLockWait?<T>(
    operation: () => T,
  ): { readonly busy: false; readonly value: T } | { readonly busy: true };
  /**
   * C-635: defer an activity time; it rides along with this backend's next
   * write transaction or `flushDeferredActivity`, rechecked there.
   */
  deferAssignmentActivity?(entry: McpDeferredActivity): void;
  /** C-635: deferred activity times not yet written. */
  deferredAssignmentActivity?(): readonly McpDeferredActivity[];
  /** C-635: write every deferred activity time; no transaction when none. */
  flushDeferredActivity?(): number;
  /** C-635: the Assignment's dispatched Runs without a project-wide scan. */
  dispatchedRunIds?(
    project_id: ProjectId,
    assignment_id: AssignmentId,
  ): readonly RunId[];
  /**
   * Transactions. Read-only paths use `read` (`BEGIN DEFERRED`), so they do not
   * take the write lock and keep working while another process writes.
   */
  readonly uow: {
    run<T>(operation: (transaction: TransactionContext) => T): T;
    read<T>(operation: (transaction: McpReadContext) => T): T;
  };
  getUpdates(params: {
    readonly project_id: ProjectId;
    readonly card_id?: CardId;
    readonly since_seq?: number;
  }): McpUpdates;
  /**
   * C-785: a stream's events of one type from the table, for types the
   * Store's in-memory event log leaves out (`NON_RESIDENT_EVENT_TYPES`).
   * Backends without it keep every event in `events.listAfter`.
   */
  streamEventsOfType?(
    project_id: ProjectId,
    card_id: CardId | undefined,
    type: string,
  ): readonly Event[];
  /** C-785: one event by stream and seq from the table, of any type. */
  eventAt?(
    project_id: ProjectId,
    card_id: CardId | undefined,
    seq: number,
  ): Event | undefined;
  ackEvents(params: {
    readonly project_id: ProjectId;
    readonly assignment_id: AssignmentId;
    /** The card stream, or `""` (the project stream) for project-level events. */
    readonly card_id: CardId | "";
    readonly up_to_seq: number;
  }): Result<McpAckResult>;
}
