import type {
  Assignment,
  AssignmentId,
  Attachment,
  AttachmentId,
  Card,
  CardId,
  Cursor,
  Decision,
  DecisionId,
  Delivery,
  DeliveryId,
  Event,
  EventRepository,
  HumanAction,
  HumanActionId,
  Machine,
  MachineId,
  ProjectId,
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
  readonly events: Pick<EventRepository, "listAfter">;
}

/**
 * Everything the MCP layer needs from the control plane's store.
 *
 * A structural port: the SQLite `Store` from `@cardigan/store` satisfies it
 * without knowing about MCP, and apps/server decides which implementation to
 * pass in. Only `domain` types appear in this surface.
 */
export interface McpBackend {
  /** Resolve a token by its stored hash; revoked tokens resolve to `undefined`. */
  verifyToken(token: string): McpToken | undefined;
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
  ackEvents(params: {
    readonly project_id: ProjectId;
    readonly assignment_id: AssignmentId;
    readonly card_id: CardId;
    readonly up_to_seq: number;
  }): Result<McpAckResult>;
}
