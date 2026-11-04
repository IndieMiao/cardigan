import type {
  AssignmentId,
  CardId,
  Event,
  ProjectId,
  Result,
  TimelineEntry,
  ToolName,
  TransactionContext,
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
  /** Run a read (or write) against the repositories in one transaction. */
  readonly uow: {
    run<T>(operation: (transaction: TransactionContext) => T): T;
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
