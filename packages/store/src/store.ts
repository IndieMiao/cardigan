import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as Path from "node:path";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Assignment,
  AssignmentId,
  CardId,
  Clock,
  Cursor,
  Event,
  GlobalIdAllocator,
  GlobalRepositories,
  IdAllocator,
  NotificationStatus,
  ProjectId,
  ReadMachinePlacement,
  Result,
  RunId,
  TimelineEntry,
  ToolName,
  TransactionContext,
  UnitOfWork,
} from "@cardigan/domain";
import { suggestProjectCode, validateProjectCode } from "@cardigan/domain";
import {
  type ChangeCursor,
  type ChangeSet,
  changesSince,
} from "./change-feed.js";
import {
  CommandEvents,
  type HotStateHints,
  hotStateHints,
} from "./command-events.js";
import {
  CommandSnapshots,
  type SnapshotTransaction,
} from "./command-snapshots.js";
import { unfinishedBellAttempts } from "./dispatcher.js";
import {
  createGlobalIdAllocator,
  createGlobalRepositories,
} from "./employees.js";
import {
  backupBeforeIdFormatMigration,
  ID_FORMAT_MIGRATION_NAME,
  legacyRequest,
} from "./id-format-migration.js";
import {
  type BufferedIdAllocator,
  createBufferedIdAllocator,
  createIdAllocator,
  PROJECT_EVENT_STREAM,
} from "./ids.js";
import {
  acknowledgeNotifications,
  advanceRouterCursor,
  listNotifications,
  type MoveNotificationInput,
  moveNotification,
  type NotificationQuery,
  notificationsByRecipient,
  type RecordNotificationInput,
  recordNotification,
  routerCursor,
} from "./inbox.js";
import { seedLocalMachine } from "./machines.js";
import {
  type AppliedMigration,
  defaultMigrationsDir,
  listMigrations,
  migrate,
} from "./migrate.js";
import { projectCodeSource, projectCodes } from "./project-codes.js";
import {
  listFindings,
  type ReconcileFindingInput,
  recordFindings,
} from "./reconcile.js";
import {
  clearRepositoryCache,
  createReadRepositories,
  createRepositories,
  platformDeploymentReader,
  type ReadEventRepository,
  type ReadRepositories,
} from "./repositories.js";
import { RunResourceAuthority } from "./run-resource-authority.js";
import { backfillStandingModesInTransaction } from "./standing.js";
import { prepare } from "./statements.js";
import { seedCardTemplates } from "./templates.js";
import {
  findTokenByHash,
  type IssuedToken,
  type IssueTokenInput,
  issueToken,
  revokeToken,
  type TokenRecord,
  tokensForAssignment,
  verifyToken,
} from "./tokens.js";
import {
  countWebSessions,
  createWebSession,
  findWebSession,
  type IssuedWebSession,
  revokeWebSession,
  setWebPassword,
  verifyWebLogin,
  type WebCredential,
  type WebSession,
  webPasswordConfigured,
} from "./web-auth.js";

export const DEFAULT_DB_FILE = "cardigan.db";

export interface StoreTransactionContext
  extends TransactionContext,
    GlobalRepositories {
  readonly events: TransactionContext["events"] & ReadEventRepository;
  readonly employees: GlobalRepositories["employees"];
  readonly members: GlobalRepositories["members"];
  readonly cachedCommandState?: SnapshotTransaction["state"];
  readonly command_state_scope?: CommandStateScope;
  readonly hot_state_hints?: HotStateHints;
  readonly platformDeployments: (project: ProjectId, sha: string) => Event[];
  readonly global_ids: GlobalIdAllocator;
  /** Issue a token inside this transaction (assignment and token commit together). */
  issueToken(input: IssueTokenInput): IssuedToken;
  /** Every token row of an assignment, newest last; values are never exposed. */
  tokensForAssignment(
    project_id: ProjectId,
    assignment_id: AssignmentId,
  ): readonly TokenRecord[];
  /** Revoke one token inside this transaction. */
  revokeToken(id: string): boolean;
}

/** `UnitOfWork` plus read-only transactions. */
export interface StoreUnitOfWork extends UnitOfWork {
  run<T>(operation: (transaction: StoreTransactionContext) => T): T;
  /**
   * Run `operation` in a `BEGIN DEFERRED` transaction with read-only
   * repositories. In WAL mode this does not take the write lock, so it keeps
   * working while another process is writing.
   */
  read<T>(operation: (transaction: ReadRepositories) => T): T;
  /**
   * C-641: compute in a read snapshot, then commit in a short write
   * transaction. See `Store.optimistic`.
   */
  optimistic<T>(
    project: ProjectId,
    plan: (transaction: OptimisticContext) => OptimisticPlan<T>,
    options?: OptimisticOptions,
  ): T;
}

/**
 * C-641: what an optimistic plan may read. Repositories are read-only; IDs are
 * numbered in memory and only written if the plan commits.
 */
export interface OptimisticContext extends ReadRepositories {
  readonly ids: IdAllocator;
  readonly read_machine_placement?: ReadMachinePlacement;
}

export interface OptimisticPlan<T> {
  readonly value: T;
  /**
   * Persist the plan. Runs under the writer lock only after the project's
   * command-state version and every used ID counter are unchanged since the
   * snapshot. Omit when there is nothing to write: no writer lock is taken.
   */
  readonly write?: (transaction: StoreTransactionContext) => void;
}

export interface OptimisticOptions {
  /** Snapshot attempts before the pessimistic fallback; `0` goes straight to it. */
  readonly attempts?: number;
}

/** Conflicting snapshots retried before falling back to `BEGIN IMMEDIATE`. */
export const DEFAULT_OPTIMISTIC_ATTEMPTS = 3;
const MAX_OPTIMISTIC_ATTEMPTS = 20;

export interface OptimisticStats {
  /** Committed from a snapshot plan. */
  readonly committed: number;
  /** A snapshot plan with nothing to write; no writer lock taken. */
  readonly unchanged: number;
  /** Snapshot plans discarded because the read set changed before commit. */
  readonly conflicts: number;
  /** Plans run pessimistically (attempt limit, port outside the read set, no version table). */
  readonly fallbacks: number;
}

/** Thrown into a snapshot plan that reads a port outside the validated read set. */
class PessimisticRequired extends Error {
  constructor() {
    super("This read requires the pessimistic write transaction");
  }
}

type Planned<T> =
  | {
      readonly kind: "planned";
      readonly plan: OptimisticPlan<T>;
      readonly version: string;
      readonly ids: BufferedIdAllocator;
    }
  | { readonly kind: "pessimistic" };

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  repo_path: string | null;
  base_branch: string | null;
  code?: string | null;
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id as ProjectId,
    name: row.name,
    created_at: row.created_at,
    repo_path: row.repo_path,
    base_branch: row.base_branch,
    code: row.code ?? null,
  };
}

export interface StoreOptions {
  /** Directory that holds `cardigan.db`; defaults to `$CARDIGAN_DATA_DIR` or `.data`. */
  readonly dataDir?: string;
  /** Explicit database file, overriding `dataDir`. */
  readonly dbPath?: string;
  readonly clock?: Clock;
  /** Host supervisor opens an existing schema without applying release migrations. */
  readonly migrate?: boolean;
  /** Override the migrations directory (tests). */
  readonly migrationsDir?: string;
  /**
   * C-639 command state scope; defaults to `$CARDIGAN_COMMAND_STATE`, else
   * `hot`. `full` restores the former whole-history command state.
   */
  readonly commandState?: CommandStateScope;
}

/**
 * `hot`: open cards' streams plus durable closed-card facts; `full`: all
 * history; `lean` (C-649): hot, plus closed-card GitHub dispatch records left
 * out and project-stream retention by type.
 */
export type CommandStateScope = "full" | "hot" | "lean";
export function commandStateScope(
  value: string | undefined,
): CommandStateScope {
  if (value === undefined || value === "" || value === "hot") return "hot";
  if (value === "full" || value === "lean") return value;
  throw new Error("CARDIGAN_COMMAND_STATE must be hot, lean or full");
}

export interface GetUpdatesParams {
  readonly project_id: ProjectId;
  /** Absent selects the project-level stream, not every card stream. */
  readonly card_id?: CardId;
  readonly since_seq?: number;
}

export interface GetUpdatesResult {
  readonly events: readonly Event[];
  readonly timeline: readonly TimelineEntry[];
  readonly latest_seq: number;
}

export interface AckEventsParams {
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  /**
   * The card stream, or `PROJECT_EVENT_STREAM` for project-level events — the
   * same stream `get_updates` selects when it gets no `card_id` (S5).
   */
  readonly card_id: CardId | typeof PROJECT_EVENT_STREAM;
  readonly up_to_seq: number;
}

export interface AckEventsResult {
  readonly acked_seq: number;
  /** False when the cursor was already at or past `up_to_seq`. */
  readonly changed: boolean;
}

export interface IdempotentParams<Request> {
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly key: string;
  readonly request: Request;
}

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly created_at: string;
  /** Local repository the base clone is made from (§12.2); M4 adds the bare repo. */
  readonly repo_path: string | null;
  /** Branch a worktree starts from when the card does not say otherwise. */
  readonly base_branch: string | null;
  /**
   * C-674: globally unique display code (`SEN`), immutable once registered.
   * Null only before the project-code migration or for a project that has
   * not registered one yet.
   */
  readonly code: string | null;
}

export interface ProjectCreateInput {
  readonly id: ProjectId;
  readonly name?: string;
  /**
   * C-674: the project code. Human entry points (`project create`) require
   * it; omitted here, the suggested code for the name is registered, so
   * fixtures need no code of their own.
   */
  readonly code?: string;
}

export interface IdempotentResult<T> {
  readonly value: T;
  /** True when the stored response was returned instead of running again. */
  readonly replayed: boolean;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

/**
 * SQLite-backed store.
 *
 * Everything a command writes goes through `uow.run`, which wraps the changes
 * and their events in one transaction; any throw rolls the whole command back.
 */
/**
 * C-216: optional timing hooks for the tick profiler. Only durations leave the
 * Store — never SQL text, parameters or row contents.
 */
export interface StoreObserver {
  /** Whole UnitOfWork; a guarded promotion reports its contiguous read and write phases separately. */
  transaction?(kind: "run" | "read", durationMs: number): void;
  /** A command-state cache miss rebuilt inside a UnitOfWork. */
  stateBuild?(durationMs: number): void;
  /**
   * C-638: a `BEGIN IMMEDIATE` write transaction: the wait for SQLite's write
   * lock (busy timeout included) and, once held, the time until it was
   * released by commit or rollback. `holdMs` is undefined when it was never
   * acquired.
   */
  writeLock?(waitMs: number, holdMs: number | undefined): void;
}

type PlacementReader = (
  tx: ReadRepositories,
  ...args: Parameters<ReadMachinePlacement>
) => ReturnType<ReadMachinePlacement>;

/** C-635: an MCP activity time waiting to ride along with a write. */
export interface DeferredActivity {
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly at: string;
  /** C-600: the request's Token; another launch's Token is not activity. */
  readonly token_id?: string;
}

export class Store {
  readonly #db: DatabaseSync;
  #observer: StoreObserver | undefined;
  readonly #clock: Clock;
  readonly #migrationsDir: string | undefined;
  #inTransaction = false;
  #rollbacks = 0;
  #placement: PlacementReader | undefined;
  setMachinePlacementReader(reader: PlacementReader) {
    this.#placement = reader;
  }
  #testReviewTrust: import("@cardigan/domain").TestReviewTrust | undefined;

  /** Host assembly only; the port itself is never serialized or cached. */
  setTestReviewTrust(
    trust: import("@cardigan/domain").TestReviewTrust | undefined,
  ): void {
    this.#testReviewTrust = trust;
  }
  #snapshots: CommandSnapshots | undefined;
  readonly #commandEvents = new CommandEvents();
  #commandStateScope: CommandStateScope = "hot";
  get commandStateScope(): CommandStateScope {
    return this.#commandStateScope;
  }
  /** C-635: deferred MCP activity, keyed by project, Assignment and Token. */
  readonly #deferredActivity = new Map<string, DeferredActivity>();

  /** Call inside the consuming transaction: covers local writes and other connections. */
  snapshotVersion(project: ProjectId): string | undefined {
    if (!this.#snapshots) return undefined;
    return `${this.#snapshots.version(project)}:${this.#rollbacks}`;
  }

  /**
   * C-244: changed row ids since `since` (see `changesSince`); call inside the
   * consuming transaction. `undefined` when the database has no change feed.
   */
  changesSince(
    project: ProjectId,
    collections: readonly string[],
    since: ChangeCursor | undefined,
  ): ChangeSet | undefined {
    if (!this.#snapshots) return undefined;
    return changesSince(this.#db, project, collections, since);
  }

  readonly runResources: RunResourceAuthority;
  private constructor(db: DatabaseSync, clock: Clock, migrationsDir?: string) {
    this.#db = db;
    this.runResources = new RunResourceAuthority(db);
    this.#clock = clock;
    this.#migrationsDir = migrationsDir;
  }

  /** Open (creating if needed) the database, then apply pending migrations. */
  static open(options: StoreOptions = {}): Store {
    const dataDir = options.dataDir ?? process.env.CARDIGAN_DATA_DIR ?? ".data";
    const dbPath = options.dbPath ?? join(dataDir, DEFAULT_DB_FILE);
    // Only create a directory we own; an explicit dbPath brings its own.
    mkdirSync(options.dbPath === undefined ? dataDir : dirname(dbPath), {
      recursive: true,
    });

    const db = new DatabaseSync(dbPath);
    const store = new Store(
      db,
      options.clock ?? systemClock,
      options.migrationsDir,
    );
    store.#commandStateScope =
      options.commandState ??
      commandStateScope(process.env.CARDIGAN_COMMAND_STATE);
    try {
      // Opening/configuring the database can contend with another process too.
      db.exec("PRAGMA busy_timeout = 5000");
      // SQLite's explicit in-memory and temporary databases do not support WAL.
      if (dbPath !== ":memory:" && dbPath !== "") enableWal(db);
      db.exec("PRAGMA foreign_keys = ON");
      if (options.migrate === false) {
        if (
          !db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name = 'schema_version'",
            )
            .get()
        )
          throw new Error(
            "Existing Cardigan schema required without migrations",
          );
        store.#refreshSnapshots();
      } else {
        // C-132: the id-format migration rewrites stored values; keep a copy.
        backupBeforeIdFormatMigration(
          db,
          dbPath,
          (options.clock ?? systemClock).now(),
          listMigrations(options.migrationsDir ?? defaultMigrationsDir),
        );
        store.migrate();
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return store;
  }

  /** C-216: install (or clear with `undefined`) timing hooks. Off by default. */
  observe(observer: StoreObserver | undefined): void {
    this.#observer = observer;
  }

  #timed<T>(kind: "run" | "read", operation: () => T): T {
    const observer = this.#observer;
    if (!observer?.transaction) return operation();
    const started = performance.now();
    try {
      return operation();
    } finally {
      observer.transaction(kind, performance.now() - started);
    }
  }

  #cachedState(
    snapshots: SnapshotTransaction | undefined,
  ): Pick<StoreTransactionContext, "cachedCommandState"> {
    if (!snapshots) return {};
    const observer = this.#observer;
    if (!observer?.stateBuild) return { cachedCommandState: snapshots.state };
    return {
      cachedCommandState: (project, build) =>
        snapshots.state(project, () => {
          const started = performance.now();
          try {
            return build();
          } finally {
            observer.stateBuild?.(performance.now() - started);
          }
        }),
    };
  }

  /** Persistent per-Assignment log debit; BEGIN IMMEDIATE serializes all readers. */
  withCheckLogBudget<T>(
    key: {
      project_id: ProjectId;
      card_id: CardId;
      attempt_id: string;
      assignment_id: AssignmentId;
    },
    maximum: number,
    consume: (
      remaining: number,
      tx: StoreTransactionContext,
    ) => { bytes: number; value: T },
  ): T {
    if (!Number.isSafeInteger(maximum) || maximum <= 0)
      throw new Error("Invalid check log budget");
    return this.#run((tx) => {
      const args = [
        key.project_id,
        key.card_id,
        key.attempt_id,
        key.assignment_id,
      ];
      const used = Number(
        this.#db
          .prepare(
            "SELECT bytes FROM check_log_debits WHERE project_id=? AND card_id=? AND attempt_id=? AND assignment_id=?",
          )
          .get(...args)?.bytes ?? 0,
      );
      const remaining = Math.max(0, maximum - used);
      const result = consume(remaining, tx);
      if (
        !Number.isSafeInteger(result.bytes) ||
        result.bytes < 0 ||
        result.bytes > remaining
      )
        throw new Error("Invalid check log debit");
      this.#db
        .prepare(
          "INSERT INTO check_log_debits (project_id,card_id,attempt_id,assignment_id,bytes) VALUES (?,?,?,?,?) ON CONFLICT(project_id,card_id,attempt_id,assignment_id) DO UPDATE SET bytes=excluded.bytes",
        )
        .run(...args, used + result.bytes);
      return result.value;
    });
  }

  get database(): DatabaseSync {
    return this.#db;
  }

  migrate(): AppliedMigration[] {
    const applied = migrate(this.#db, this.#migrationsDir, () =>
      this.#clock.now(),
    );
    this.#refreshSnapshots();
    return applied;
  }

  #refreshSnapshots(): void {
    clearRepositoryCache(this.#db);
    this.#snapshots = this.#db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'command_versions'")
      .get()
      ? new CommandSnapshots(this.#db)
      : undefined;
  }

  /** Latest applied migration version, `0` for an empty database. */
  schemaVersion(): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_version",
      )
      .get();
    return Number((row as { version: number }).version);
  }

  close(): void {
    this.#db.close();
  }

  get uow(): StoreUnitOfWork {
    return {
      run: <T>(operation: (transaction: StoreTransactionContext) => T): T =>
        this.#timed("run", () => this.#run(operation)),
      read: <T>(operation: (transaction: ReadRepositories) => T): T =>
        this.#timed("read", () => this.#read(operation)),
      optimistic: (project, plan, options) =>
        this.optimistic(project, plan, options),
    };
  }

  #optimisticStats = { committed: 0, unchanged: 0, conflicts: 0, fallbacks: 0 };
  get optimisticStats(): OptimisticStats {
    return { ...this.#optimisticStats };
  }

  /**
   * C-641: optimistic command commit. `plan` computes in a `BEGIN DEFERRED`
   * snapshot without the writer lock. Its read set is the project's
   * command-state version (the key of the command-state cache: project
   * collections, global identities and all Assignments) plus the ID counters
   * it used. Under `BEGIN IMMEDIATE` both are compared with the snapshot; only
   * if unchanged does `write` run, so the lock covers persistence alone.
   *
   * A changed read set discards the plan and recomputes, at most `attempts`
   * times; then (or when the plan reads machine placement or other projects'
   * deployment records, which lie outside the project version) the plan and
   * its write run in one `BEGIN IMMEDIATE`
   * transaction exactly like `uow.run`. Plans must therefore be repeatable:
   * no side effects outside the transaction they are given.
   */
  optimistic<T>(
    project: ProjectId,
    plan: (transaction: OptimisticContext) => OptimisticPlan<T>,
    options: OptimisticOptions = {},
  ): T {
    if (this.#inTransaction)
      throw new Error("nested UnitOfWork is not supported");
    const attempts = options.attempts ?? DEFAULT_OPTIMISTIC_ATTEMPTS;
    if (
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      attempts > MAX_OPTIMISTIC_ATTEMPTS
    )
      throw new Error("Invalid optimistic attempt limit");
    const snapshots = this.#snapshots;
    if (snapshots)
      for (let attempt = 0; attempt < attempts; attempt++) {
        const planned = this.#planInSnapshot(project, snapshots, plan);
        if (planned.kind === "pessimistic") break;
        const write = planned.plan.write;
        if (!write) {
          this.#optimisticStats.unchanged++;
          return planned.plan.value;
        }
        if (this.#commitPlanned(project, snapshots, planned, write)) {
          this.#optimisticStats.committed++;
          return planned.plan.value;
        }
        this.#optimisticStats.conflicts++;
      }
    this.#optimisticStats.fallbacks++;
    return this.#timed("run", () =>
      this.#run((tx) => {
        const planned = plan(tx);
        planned.write?.(tx);
        return planned.value;
      }),
    );
  }

  #planInSnapshot<T>(
    project: ProjectId,
    snapshots: CommandSnapshots,
    plan: (transaction: OptimisticContext) => OptimisticPlan<T>,
  ): Planned<T> {
    const db = this.#db;
    const started = performance.now();
    db.exec("BEGIN DEFERRED");
    this.#inTransaction = true;
    let finished = false;
    const events = this.#commandEvents.transaction(db);
    const cache = snapshots.transaction();
    try {
      // The first read pins the snapshot the plan and its version share.
      const version = snapshots.version(project);
      const trust = this.#testReviewTrust;
      const ids = createBufferedIdAllocator(db);
      let outside = false;
      const repositories = createReadRepositories(db, cache);
      const context: OptimisticContext = {
        ...repositories,
        ...this.#cachedState(cache),
        ...(trust ? { test_review_trust: trust } : {}),
        ...(this.#placement
          ? {
              read_machine_placement: () => {
                outside = true;
                throw new PessimisticRequired();
              },
            }
          : {}),
        // Other projects' deployment records are outside the project version.
        platformDeployments: () => {
          outside = true;
          throw new PessimisticRequired();
        },
        // Same history view and scope as `#run` and `#read` (C-639, C-640).
        events: {
          ...repositories.events,
          listAfter: events.listAfter,
          listStreams: events.listStreams,
        },
        command_state_scope: this.#commandStateScope,
        hot_state_hints: hotStateHints(this.#db),
        ids: ids.ids,
      };
      let result: OptimisticPlan<T>;
      try {
        result = plan(context);
      } catch (error) {
        // A domain wrapper may have converted the signal; the flag still holds.
        if (outside) return { kind: "pessimistic" };
        throw error;
      }
      if (outside || trust !== this.#testReviewTrust)
        return { kind: "pessimistic" };
      db.exec("COMMIT");
      finished = true;
      events.commit();
      cache.commit();
      return { kind: "planned", plan: result, version, ids };
    } finally {
      if (!finished) db.exec("ROLLBACK");
      this.#inTransaction = false;
      this.#observer?.transaction?.("read", performance.now() - started);
    }
  }

  #commitPlanned<T>(
    project: ProjectId,
    snapshots: CommandSnapshots,
    planned: Extract<Planned<T>, { kind: "planned" }>,
    write: (transaction: StoreTransactionContext) => void,
  ): boolean {
    const db = this.#db;
    const started = performance.now();
    db.exec("BEGIN IMMEDIATE");
    let handedOff = false;
    try {
      if (
        snapshots.version(project) !== planned.version ||
        !planned.ids.unchanged()
      )
        return false;
      handedOff = true;
      this.#writeAndCommit((tx) => {
        planned.ids.flush();
        write(tx);
      });
      return true;
    } finally {
      if (!handedOff) db.exec("ROLLBACK");
      this.#observer?.transaction?.("run", performance.now() - started);
    }
  }

  /** Recheck a single external-evidence-dependent write in a pinned read snapshot.
   * No callback, await or lock wait between the final check and promotion. A WAL
   * conflict discards the plan; an unchanged DB cannot mask a revoked trust port. */
  tryGuardedWrite(
    revision: () => string,
    expected: string,
    guard: (
      trust: ReadRepositories["test_review_trust"],
    ) => ((tx: StoreTransactionContext) => void) | undefined,
  ): string | undefined {
    if (this.#inTransaction)
      throw new Error("nested UnitOfWork is not supported");
    const db = this.#db;
    const observer = this.#observer;
    const start = performance.now();
    let promoteAt: number | undefined;
    let handedOff = false;
    db.exec("BEGIN DEFERRED");
    this.#inTransaction = true;
    try {
      // Pin before invoking caller code, even if the revision is cached.
      db.prepare("SELECT version FROM schema_version LIMIT 1").get();
      if (revision() !== expected) return;
      const timeout = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout);
      const trust = this.#testReviewTrust;
      const append = guard(trust);
      if (!append || trust !== this.#testReviewTrust) return expected;
      promoteAt = performance.now();
      try {
        db.exec("PRAGMA busy_timeout = 0");
        // Obtain the writer lock without mutating a row or running a trigger.
        db.exec("UPDATE projects SET name = name WHERE 0");
      } catch (error) {
        if (isSqliteBusy(error)) return;
        throw error;
      } finally {
        db.exec(`PRAGMA busy_timeout = ${timeout}`);
      }
      handedOff = true;
      return this.#writeAndCommit((tx) => {
        append(tx);
        return revision();
      });
    } finally {
      if (!handedOff) {
        db.exec("ROLLBACK");
        this.#inTransaction = false;
      }
      // Report both phases after the transaction, never between check and write.
      const end = performance.now();
      observer?.transaction?.("read", (promoteAt ?? end) - start);
      if (promoteAt !== undefined)
        observer?.transaction?.("run", end - promoteAt);
    }
  }

  #run<T>(operation: (transaction: StoreTransactionContext) => T): T {
    if (this.#inTransaction) {
      throw new Error("nested UnitOfWork is not supported");
    }
    const observer = this.#observer;
    if (!observer?.writeLock) {
      this.#db.exec("BEGIN IMMEDIATE");
      return this.#writeAndCommit(operation);
    }
    // Timing never changes a transaction's result or error.
    const report = (waitMs: number, holdMs: number | undefined) => {
      try {
        observer.writeLock?.(waitMs, holdMs);
      } catch {
        // Ignored.
      }
    };
    const started = performance.now();
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      report(performance.now() - started, undefined);
      throw error;
    }
    const acquired = performance.now();
    try {
      return this.#writeAndCommit(operation);
    } finally {
      report(acquired - started, performance.now() - acquired);
    }
  }

  #writeAndCommit<T>(
    operation: (transaction: StoreTransactionContext) => T,
  ): T {
    this.#inTransaction = true;
    let active = true;
    const events = this.#commandEvents.transaction(this.#db);
    const snapshots = this.#snapshots?.transaction();
    try {
      const repositories = createRepositories(this.#db, snapshots);
      const reader = this.#placement;
      const tx: StoreTransactionContext = {
        unreservedAssignment: (project, assignment) => {
          if (!active) throw new Error("Reservation transaction has ended");
          return (
            !unfinishedBellAttempts(this.#db, project, assignment).length &&
            !this.#db
              .prepare(
                "SELECT 1 FROM machine_resource_leases WHERE project=? AND assignment_id=? AND verified_at IS NULL LIMIT 1",
              )
              .get(project, assignment)
          );
        },
        ...(reader
          ? {
              read_machine_placement: (...args) => {
                if (!active)
                  throw new Error("Machine placement transaction has ended");
                return reader(tx, ...args);
              },
            }
          : {}),
        ...repositories,
        ...this.#cachedState(snapshots),
        ...(this.#testReviewTrust
          ? { test_review_trust: this.#testReviewTrust }
          : {}),
        events: {
          ...repositories.events,
          listAfter: events.listAfter,
          listStreams: events.listStreams,
        },
        command_state_scope: this.#commandStateScope,
        hot_state_hints: hotStateHints(this.#db),
        platformDeployments: platformDeploymentReader(this.#db),
        ...createGlobalRepositories(this.#db, "write", snapshots),
        global_ids: createGlobalIdAllocator(this.#db),
        ids: createIdAllocator(this.#db),
        issueToken: (input) => {
          if (!active) throw new Error("Token transaction has ended");
          return issueToken(this.#db, input, () => this.#clock.now());
        },
        tokensForAssignment: (project_id, assignment_id) => {
          if (!active) throw new Error("Token transaction has ended");
          return tokensForAssignment(this.#db, project_id, assignment_id);
        },
        revokeToken: (id) => {
          if (!active) throw new Error("Token transaction has ended");
          return revokeToken(this.#db, id, () => this.#clock.now());
        },
      };
      const result = operation(tx);
      // C-635: deferred MCP activity rides along with this write.
      const settled = this.#applyDeferredActivity();
      this.#db.exec("COMMIT");
      for (const [key, entry] of settled)
        if (this.#deferredActivity.get(key) === entry)
          this.#deferredActivity.delete(key);
      events.commit();
      snapshots?.commit();
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#rollbacks++;
      throw error;
    } finally {
      active = false;
      this.#inTransaction = false;
    }
  }

  /**
   * Read-only counterpart of `#run`: `BEGIN DEFERRED` plus repositories that
   * only expose `get`/`list` (and `events.listAfter`). A write attempt throws
   * `ReadOnlyTransactionError`.
   */
  #read<T>(operation: (transaction: ReadRepositories) => T): T {
    if (this.#inTransaction) {
      throw new Error("nested UnitOfWork is not supported");
    }
    this.#db.exec("BEGIN DEFERRED");
    this.#inTransaction = true;
    const events = this.#commandEvents.transaction(this.#db);
    const snapshots = this.#snapshots?.transaction();
    try {
      const repositories = createReadRepositories(this.#db, snapshots);
      const result = operation({
        ...repositories,
        projectMergeEvents: events.projectMergeEvents,
        ...this.#cachedState(snapshots),
        ...(this.#testReviewTrust
          ? { test_review_trust: this.#testReviewTrust }
          : {}),
        events: {
          ...repositories.events,
          listAfter: events.listAfter,
          listStreams: events.listStreams,
        },
        command_state_scope: this.#commandStateScope,
        hot_state_hints: hotStateHints(this.#db),
      });
      this.#db.exec("COMMIT");
      events.commit();
      snapshots?.commit();
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#rollbacks++;
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  /**
   * C-649: decode up to `rows` more of a project's events into the shared
   * command-event log in a short read transaction. Returns true once the log
   * is current; callers yield between calls to keep restart pauses short.
   */
  warmCommandEvents(project: ProjectId, rows = 50_000): boolean {
    if (this.#inTransaction) {
      throw new Error("nested UnitOfWork is not supported");
    }
    this.#db.exec("BEGIN DEFERRED");
    this.#inTransaction = true;
    const events = this.#commandEvents.transaction(this.#db);
    try {
      const done = events.warm(project, rows);
      this.#db.exec("COMMIT");
      events.commit();
      return done;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#rollbacks++;
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  /**
   * Events after `since_seq` plus the timeline entries they carry, ordered by
   * `seq` (development plan §6.1 step 4).
   */
  getUpdates(params: GetUpdatesParams): GetUpdatesResult {
    const since_seq = params.since_seq ?? 0;
    const events = createRepositories(this.#db).events.listAfter(
      params.project_id,
      params.card_id,
      since_seq,
    );
    const timeline =
      params.card_id === undefined
        ? []
        : this.#timelineAfter(params.project_id, params.card_id, since_seq);
    return {
      events,
      timeline,
      latest_seq: this.#latestSequence(params.project_id, params.card_id),
    };
  }

  /**
   * Move a read cursor forward. A cursor never goes backwards: an older or
   * repeated `up_to_seq` returns the current value unchanged, and a value past
   * the newest event is rejected instead of being silently clamped.
   */
  ackEvents(params: AckEventsParams): Result<AckEventsResult> {
    // One write transaction, so the newest-seq check and the cursor update
    // cannot interleave with another writer.
    return this.#run((tx) => {
      const latest = this.#latestSequence(params.project_id, params.card_id);
      if (params.up_to_seq > latest) {
        return {
          ok: false,
          error: {
            code: "validation_failed",
            message: `cannot ack seq ${params.up_to_seq}: newest seq is ${latest}`,
          },
        };
      }

      const acked_seq =
        this.#cursor(params.project_id, params.assignment_id, params.card_id)
          ?.acked_seq ?? 0;
      if (params.up_to_seq <= acked_seq) {
        return { ok: true, value: { acked_seq, changed: false } };
      }

      tx.cursors.put(params.project_id, {
        assignment_id: params.assignment_id,
        // `""` is the project-level stream; the cursor row keys streams by
        // their event-stream id, exactly like `events.stream`.
        card_id: params.card_id as CardId,
        acked_seq: params.up_to_seq,
      });
      return {
        ok: true,
        value: { acked_seq: params.up_to_seq, changed: true },
      };
    });
  }

  /**
   * Run `operation` at most once per `(assignment, key)`.
   *
   * Same key with the same request content returns the stored result; the same
   * key with different content is an `idempotency_conflict` and runs nothing.
   */
  runIdempotent<T>(
    params: IdempotentParams<unknown>,
    operation: (tx: StoreTransactionContext) => T,
  ): Result<IdempotentResult<T>> {
    return this.#runIdempotent(params, operation);
  }

  /** The single Workbench human is independent of sessions and MCP Assignments. */
  runHumanIdempotent<T>(
    params: Omit<IdempotentParams<unknown>, "assignment_id">,
    operation: (tx: StoreTransactionContext) => T,
  ): Result<IdempotentResult<T>> {
    return this.#runIdempotent(
      { ...params, assignment_id: "human" },
      operation,
      24 * 60 * 60 * 1000,
    );
  }

  /**
   * C-132: a record written before migration 0018 hashed the request as the
   * old server saw it — ids in the `q(n)` / `h(n)` spelling. A retry of that
   * same request now arrives normalized to `Q-n` / `H-n`; it still replays.
   * Only pre-migration records qualify, and only the exact legacy spelling of
   * this request matches, so a different request still conflicts.
   */
  #legacyReplay(
    existing: { readonly request_hash: string; readonly created_at: string },
    request: unknown,
  ): boolean {
    const migrated = this.#db
      .prepare("SELECT applied_at FROM schema_version WHERE name = ?")
      .get(ID_FORMAT_MIGRATION_NAME) as { applied_at: string } | undefined;
    return (
      migrated !== undefined &&
      existing.created_at < migrated.applied_at &&
      existing.request_hash === hashRequest(legacyRequest(request))
    );
  }

  #runIdempotent<T>(
    params: Omit<IdempotentParams<unknown>, "assignment_id"> & {
      readonly assignment_id: string;
    },
    operation: (tx: StoreTransactionContext) => T,
    retentionMs?: number,
  ): Result<IdempotentResult<T>> {
    const request_hash = hashRequest(params.request);
    // The lookup, the operation and the row that records it share one
    // transaction, so a competing writer cannot slip a second execution in.
    return this.#run((tx) => {
      if (retentionMs !== undefined) {
        this.#db
          .prepare(
            "DELETE FROM idempotency WHERE project_id = ? AND assignment_id = ? AND created_at <= ?",
          )
          .run(
            params.project_id,
            params.assignment_id,
            new Date(Date.parse(this.#clock.now()) - retentionMs).toISOString(),
          );
      }
      const existing = this.#db
        .prepare(
          "SELECT request_hash, response, created_at FROM idempotency " +
            "WHERE project_id = ? AND assignment_id = ? AND key = ?",
        )
        .get(params.project_id, params.assignment_id, params.key) as
        | { request_hash: string; response: string; created_at: string }
        | undefined;

      if (existing !== undefined) {
        if (
          existing.request_hash !== request_hash &&
          !this.#legacyReplay(existing, params.request)
        ) {
          return {
            ok: false,
            error: {
              code: "idempotency_conflict",
              message: `idempotency_key ${params.key} was used with a different request`,
              details: { key: params.key },
            },
          } satisfies Result<never>;
        }
        return {
          ok: true,
          value: {
            value: JSON.parse(existing.response) as T,
            replayed: true,
          },
        } satisfies Result<IdempotentResult<T>>;
      }

      const value = operation(tx);
      this.#db
        .prepare(
          "INSERT INTO idempotency (project_id, assignment_id, key, request_hash, response, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          params.project_id,
          params.assignment_id,
          params.key,
          request_hash,
          JSON.stringify(value),
          this.#clock.now(),
        );
      return {
        ok: true,
        value: { value, replayed: false },
      } satisfies Result<IdempotentResult<T>>;
    });
  }

  /**
   * Record a project id. Fails instead of overwriting an existing project, so a
   * typo in `project create` is visible rather than silently rebranding.
   */
  createProject(input: ProjectCreateInput): Result<ProjectRecord> {
    const existing = this.getProject(input.id);
    if (existing !== undefined) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: `project ${input.id} already exists`,
          details: { project_id: input.id },
        },
      };
    }
    const name = input.name ?? input.id;
    let code: string | null = null;
    if (this.#hasProjectCodes()) {
      const taken = projectCodes(this.#db);
      if (input.code === undefined)
        code = suggestProjectCode(
          projectCodeSource({ id: input.id, name }),
          taken,
        );
      else {
        const valid = validateProjectCode(input.code, taken);
        if (!valid.ok) return valid;
        code = valid.value;
      }
    } else if (input.code !== undefined) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: "this database has no project codes yet",
        },
      };
    }
    const record: ProjectRecord = {
      id: input.id,
      name,
      created_at: this.#clock.now(),
      repo_path: null,
      base_branch: null,
      code,
    };
    this.uow.run(() => {
      if (code === null)
        this.#db
          .prepare(
            "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
          )
          .run(record.id, record.name, record.created_at);
      else
        this.#db
          .prepare(
            "INSERT INTO projects (id, name, created_at, code) VALUES (?, ?, ?, ?)",
          )
          .run(record.id, record.name, record.created_at, code);
      seedCardTemplates(this.#db, record.id);
      if (this.schemaVersion() >= 26)
        seedLocalMachine(this.#db, record.id, record.created_at);
    });
    return { ok: true, value: record };
  }

  getProject(id: ProjectId): ProjectRecord | undefined {
    const row = this.#db
      .prepare(`SELECT ${this.#projectColumns()} FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : projectRecord(row);
  }

  /** C-674: the project a full number's code names, if any. */
  projectByCode(code: string): ProjectRecord | undefined {
    if (!this.#hasProjectCodes()) return undefined;
    const row = this.#db
      .prepare(`SELECT ${this.#projectColumns()} FROM projects WHERE code = ?`)
      .get(code) as ProjectRow | undefined;
    return row === undefined ? undefined : projectRecord(row);
  }

  /** C-674: display code of a project; undefined when none is registered. */
  projectCode(id: ProjectId): string | undefined {
    return this.getProject(id)?.code ?? undefined;
  }

  /**
   * C-674: register the code of a project that has none. A registered code
   * never changes, even to the same project's own suggestion.
   */
  setProjectCode(input: {
    readonly project_id: ProjectId;
    readonly code: string;
  }): Result<ProjectRecord> {
    const project = this.getProject(input.project_id);
    if (project === undefined)
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `project ${input.project_id} not found`,
        },
      };
    if (!this.#hasProjectCodes())
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: "this database has no project codes yet",
        },
      };
    if (project.code !== null)
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: `项目 ${project.id} 已登记代号 ${project.code}，登记后不可修改`,
          details: { project_id: project.id, code: project.code },
        },
      };
    const valid = validateProjectCode(input.code, projectCodes(this.#db));
    if (!valid.ok) return valid;
    const changed = this.#db
      .prepare("UPDATE projects SET code = ? WHERE id = ? AND code IS NULL")
      .run(valid.value, project.id);
    if (Number(changed.changes) !== 1) {
      // Another registration won the race; report the code actually stored.
      const stored = this.getProject(project.id)?.code ?? null;
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: `项目 ${project.id} 已登记代号 ${stored}，登记后不可修改`,
          details: { project_id: project.id, code: stored },
        },
      };
    }
    return { ok: true, value: { ...project, code: valid.value } };
  }

  #projectCodeColumn = false;
  #hasProjectCodes(): boolean {
    if (this.#projectCodeColumn) return true;
    this.#projectCodeColumn =
      this.#db
        .prepare(
          "SELECT 1 FROM pragma_table_info('projects') WHERE name = 'code'",
        )
        .get() !== undefined;
    return this.#projectCodeColumn;
  }

  #projectColumns(): string {
    return `id, name, created_at, repo_path, base_branch${this.#hasProjectCodes() ? ", code" : ""}`;
  }

  /**
   * C-634: highest seq per event stream (`""` is the project stream) in one
   * aggregate query. Streams come from the counters every append advances;
   * each max is an index lookup, so the cost follows the stream count, not
   * the history.
   */
  latestEventSeqs(project: ProjectId): Map<string, number> {
    return new Map(
      prepare(
        this.#db,
        `SELECT c.stream AS stream,
          (SELECT MAX(e.seq) FROM events e
            WHERE e.project_id = c.project_id AND e.stream = c.stream) AS seq
        FROM event_counters c WHERE c.project_id = ?`,
      )
        .all(project)
        .flatMap((row) =>
          row.seq === null ? [] : [[String(row.stream), Number(row.seq)]],
        ),
    );
  }

  /**
   * C-634: per-stream allocation counters. Allocation and append share one
   * transaction, so a committed counter is never behind its stream: a stream
   * whose counter is at or below a reader's cursor has nothing new for it.
   */
  eventStreamCounters(project: ProjectId): Map<string, number> {
    return new Map(
      prepare(
        this.#db,
        "SELECT stream, seq FROM event_counters WHERE project_id = ?",
      )
        .all(project)
        .map((row) => [String(row.stream), Number(row.seq)]),
    );
  }

  listProjects(): ProjectRecord[] {
    return this.#db
      .prepare(
        `SELECT ${this.#projectColumns()} FROM projects ORDER BY created_at, id`,
      )
      .all()
      .map((row) => projectRecord(row as unknown as ProjectRow));
  }

  /**
   * Register the project's local repository and default base branch (M2.2).
   * `repo_path` must be absolute; the branch must be a plain Git ref.
   */
  setProjectRepo(input: {
    readonly project_id: ProjectId;
    readonly repo_path: string;
    readonly base_branch?: string;
  }): Result<ProjectRecord> {
    if (!Path.isAbsolute(input.repo_path)) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: "repo_path must be absolute",
          details: { repo_path: input.repo_path },
        },
      };
    }
    const branch = input.base_branch ?? "main";
    if (!/^[A-Za-z0-9._/-]+$/u.test(branch) || branch.startsWith("-")) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: "base_branch is not a valid branch name",
          details: { base_branch: branch },
        },
      };
    }
    const changed = this.#db
      .prepare(
        "UPDATE projects SET repo_path = ?, base_branch = ? WHERE id = ?",
      )
      .run(input.repo_path, branch, input.project_id);
    if (Number(changed.changes) === 0) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `project ${input.project_id} not found`,
        },
      };
    }
    const project = this.getProject(input.project_id);
    if (project === undefined) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `project ${input.project_id} not found`,
        },
      };
    }
    return { ok: true, value: project };
  }

  issueToken(input: IssueTokenInput): IssuedToken {
    return this.#run(() =>
      issueToken(this.#db, input, () => this.#clock.now()),
    );
  }

  verifyToken(token: string): TokenRecord | undefined {
    return verifyToken(this.#db, token);
  }

  /** Narrow request proof; neither the bearer nor its reusable hash goes on the wire. */
  verifyResourceRead(
    id: string,
    key: string,
    challenge: string,
    proof: string,
  ) {
    if (!/^tok_[0-9a-f]{24}$/u.test(id) || !/^[0-9a-f]{64}$/u.test(proof))
      return undefined;
    const hash = this.#db
      .prepare(
        "SELECT token_hash FROM tokens WHERE id=? AND revoked_at IS NULL",
      )
      .get(id)?.token_hash;
    if (typeof hash !== "string") return undefined;
    const expected = createHmac("sha256", Buffer.from(hash, "hex"))
      .update(`resource-read-v1:${id}:${key}:${challenge}`)
      .digest();
    return timingSafeEqual(expected, Buffer.from(proof, "hex"))
      ? findTokenByHash(this.#db, hash)
      : undefined;
  }
  findTokenByHash(hash: string): TokenRecord | undefined {
    return findTokenByHash(this.#db, hash);
  }

  revokeToken(id: string): boolean {
    return revokeToken(this.#db, id, () => this.#clock.now());
  }

  /** M3.3: insert an inbox row unless (event, recipient) already exists. */
  recordNotification(input: RecordNotificationInput) {
    return this.#run(() =>
      recordNotification(this.#db, input, () => this.#clock.now()),
    );
  }

  listNotifications(query: NotificationQuery) {
    return listNotifications(this.#db, query);
  }

  /**
   * M4.5: stamp `standing_mode` on rows written before the field existed, using
   * their newest token once. Safe to call repeatedly and from startup.
   */
  backfillStandingModes() {
    return this.#run((tx) =>
      this.listProjects().flatMap((project) =>
        backfillStandingModesInTransaction(tx, project.id),
      ),
    );
  }

  /** M4.4: upsert one reconciliation pass and resolve what disappeared. */
  recordReconcileFindings(
    project_id: ProjectId,
    findings: readonly ReconcileFindingInput[],
    options: {
      readonly unscanned?: readonly string[];
      readonly unscannedPaths?: readonly string[];
    } = {},
  ) {
    return recordFindings(
      this.#db,
      project_id,
      findings,
      this.#clock.now(),
      options,
    );
  }

  listReconcileFindings(
    project_id: ProjectId,
    options: { readonly openOnly?: boolean } = {},
  ) {
    return listFindings(this.#db, project_id, options);
  }

  /** Pending and belled notifications grouped by recipient (§3.2). */
  notificationsByRecipient(
    project_id: ProjectId,
    statuses?: readonly NotificationStatus[],
  ) {
    return notificationsByRecipient(this.#db, project_id, statuses);
  }

  /** Apply a notification event through the domain transition table. */
  moveNotification(input: MoveNotificationInput) {
    return this.#run(() =>
      moveNotification(this.#db, input, () => this.#clock.now()),
    );
  }

  /** §3.2: confirm everything the Assignment's ACK cursor already covers. */
  acknowledgeNotifications(
    project_id: ProjectId,
    assignment_id: AssignmentId,
  ): number {
    return this.#run(() =>
      acknowledgeNotifications(
        this.#db,
        project_id,
        assignment_id,
        this.#clock.now(),
      ),
    );
  }

  /**
   * The Router's position in one stream: a card id, or
   * `PROJECT_EVENT_STREAM` for project-level events. Seqs are per stream.
   */
  routerCursor(project_id: ProjectId, stream: string): number {
    return routerCursor(this.#db, project_id, stream);
  }

  /** Monotonic per stream: a stale consumer can never move a cursor back. */
  advanceRouterCursor(
    project_id: ProjectId,
    stream: string,
    last_seq: number,
  ): number {
    return this.#run(() =>
      advanceRouterCursor(
        this.#db,
        project_id,
        stream,
        last_seq,
        this.#clock.now(),
      ),
    );
  }

  /**
   * M3.2: record that the Assignment just called the MCP endpoint. The
   * watchdog of M3 plan §3.3 uses it to tell a busy Agent from a stuck one.
   * Unknown or unreleased Assignments are silently ignored, so a tool call can
   * never fail because of this bookkeeping.
   *
   * C-600: `token_id` is the Token the request authenticated with. A verified
   * session records its launch's Token; a request on another one (a late call
   * of the replaced session) is not this session's activity and is ignored,
   * checked inside this write.
   */
  touchAssignmentActivity(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    at: string = this.#clock.now(),
    token_id?: string,
  ): boolean {
    return this.#run(() => {
      const row = this.#db
        .prepare("SELECT doc FROM assignments WHERE project_id = ? AND id = ?")
        .get(project_id, assignment_id) as { doc: string } | undefined;
      if (row === undefined) return false;
      const assignment = JSON.parse(row.doc) as Assignment;
      if (assignment.status !== "active") return false;
      if (
        token_id !== undefined &&
        assignment.mcp_session_token_id !== undefined &&
        token_id !== assignment.mcp_session_token_id
      )
        return false;
      this.#db
        .prepare(
          "UPDATE assignments SET doc = ?, last_mcp_activity_at = ? WHERE project_id = ? AND id = ?",
        )
        .run(
          JSON.stringify({
            ...assignment,
            last_mcp_activity_at: at,
          } satisfies Assignment),
          at,
          project_id,
          assignment_id,
        );
      return true;
    });
  }

  /**
   * C-600: advance the current verified session's Card MCP handshake.
   * `key_sha256` is the digest of the request's session header (or, for
   * `deadline`, the session the host timed). Only the launch's own key
   * counts as native: its `tools/list` or tool call turns `pending` into
   * `listed`. Any other tool call while pending proves the session has no
   * native tools (`missing`), and so does an expired `deadline` for the same
   * session. Other states never change here. Returns the resulting state.
   */
  advanceMcpHandshake(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    observed: "tools_listed" | "tool_called" | "deadline",
    key_sha256?: string,
    token_id?: string,
  ): Assignment["mcp_handshake"] {
    return this.#advanceMcpHandshake(
      project_id,
      assignment_id,
      observed,
      key_sha256,
      token_id,
      true,
    ).state;
  }

  /**
   * C-635: `advanceMcpHandshake` for the tool-call hot path. It never waits
   * for another process's write lock: when the transition must be written
   * and the lock is busy, the state it would have written is returned with
   * `persisted: false`, so the caller decides now and persists later.
   */
  tryAdvanceMcpHandshake(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    observed: "tools_listed" | "tool_called",
    key_sha256?: string,
    token_id?: string,
  ): {
    readonly state: Assignment["mcp_handshake"];
    readonly persisted: boolean;
  } {
    return this.#advanceMcpHandshake(
      project_id,
      assignment_id,
      observed,
      key_sha256,
      token_id,
      false,
    );
  }

  #advanceMcpHandshake(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    observed: "tools_listed" | "tool_called" | "deadline",
    key_sha256: string | undefined,
    token_id: string | undefined,
    wait: boolean,
  ): {
    readonly state: Assignment["mcp_handshake"];
    readonly persisted: boolean;
  } {
    const read = () => {
      const row = this.#db
        .prepare("SELECT doc FROM assignments WHERE project_id = ? AND id = ?")
        .get(project_id, assignment_id) as { doc: string } | undefined;
      return row && (JSON.parse(row.doc) as Assignment);
    };
    const next = (a: Assignment): NonNullable<Assignment["mcp_handshake"]> => {
      const own =
        key_sha256 !== undefined && key_sha256 === a.mcp_session_key_sha256;
      if (observed === "deadline") return own ? "missing" : "pending";
      if (own) return "listed";
      // Another launch's key comes from that launch's own harness (e.g. a
      // late call): no evidence about this session. Only a call carrying no
      // key at all — a wrapper — proves this session lacks native tools.
      return observed === "tool_called" && key_sha256 === undefined
        ? "missing"
        : "pending";
    };
    // A request on another launch's Token (e.g. a late call of the replaced
    // session) says nothing about this session.
    const foreign = (a: Assignment) =>
      token_id !== undefined &&
      a.mcp_session_token_id !== undefined &&
      token_id !== a.mcp_session_token_id;
    // Every request passes here: only a changing pending session writes.
    const seen = read();
    if (seen && foreign(seen)) return { state: undefined, persisted: true };
    if (
      seen?.status !== "active" ||
      seen.mcp_handshake !== "pending" ||
      next(seen) === "pending"
    )
      return { state: seen?.mcp_handshake, persisted: true };
    const write = () =>
      this.#timed("run", () =>
        this.#run(() => {
          const assignment = read();
          if (assignment === undefined || foreign(assignment)) return undefined;
          if (
            assignment.status !== "active" ||
            assignment.mcp_handshake !== "pending"
          )
            return assignment.mcp_handshake;
          const mcp_handshake = next(assignment);
          if (mcp_handshake === "pending") return mcp_handshake;
          this.#db
            .prepare(
              "UPDATE assignments SET doc = ? WHERE project_id = ? AND id = ?",
            )
            .run(
              JSON.stringify({
                ...assignment,
                mcp_handshake,
              } satisfies Assignment),
              project_id,
              assignment_id,
            );
          return mcp_handshake;
        }),
      );
    if (wait) return { state: write(), persisted: true };
    const attempt = this.withoutLockWait(write);
    return attempt.busy
      ? { state: next(seen), persisted: false }
      : { state: attempt.value, persisted: true };
  }

  /**
   * C-635: run `operation` (typically one write) without waiting for another
   * process's write lock: SQLite's busy timeout is 0 for its duration, and a
   * busy database yields `{ busy: true }` instead of freezing this process's
   * event loop. The operation's own transaction is rolled back as usual.
   */
  withoutLockWait<T>(
    operation: () => T,
  ): { readonly busy: false; readonly value: T } | { readonly busy: true } {
    if (this.#inTransaction)
      throw new Error("nested UnitOfWork is not supported");
    const db = this.#db;
    const timeout = Number(
      (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    );
    db.exec("PRAGMA busy_timeout = 0");
    try {
      return { busy: false, value: operation() };
    } catch (error) {
      if (isSqliteBusy(error)) return { busy: true };
      throw error;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  }

  /** C-635: this Store's clock; MCP activity is stamped with it. */
  now(): string {
    return this.#clock.now();
  }

  /**
   * C-635: defer an MCP activity time instead of writing it now. Deferred
   * times ride along with the next write transaction of this Store (any
   * command, cursor or idempotent write), or with `flushDeferredActivity`.
   * Each one obeys `touchAssignmentActivity`'s rules when it is applied
   * (active Assignment, the session's own Token), checked in that write, and
   * never moves the recorded time backwards.
   */
  deferAssignmentActivity(entry: DeferredActivity): void {
    const key = JSON.stringify([
      entry.project_id,
      entry.assignment_id,
      entry.token_id ?? null,
    ]);
    const known = this.#deferredActivity.get(key);
    if (!known || Date.parse(known.at) < Date.parse(entry.at))
      this.#deferredActivity.set(key, entry);
  }

  /** C-635: activity times deferred and not yet written. */
  deferredAssignmentActivity(): readonly DeferredActivity[] {
    return [...this.#deferredActivity.values()];
  }

  /**
   * C-635: write every deferred activity time in one transaction; nothing,
   * not even a transaction, when none is deferred. Returns how many were
   * settled (written or no longer applicable).
   */
  flushDeferredActivity(): number {
    if (this.#deferredActivity.size === 0) return 0;
    const before = this.#deferredActivity.size;
    this.#timed("run", () => this.#run(() => undefined));
    return before - this.#deferredActivity.size;
  }

  /** Inside a write transaction: apply deferred activity times. */
  #applyDeferredActivity(): [string, DeferredActivity][] {
    if (this.#deferredActivity.size === 0) return [];
    const settled: [string, DeferredActivity][] = [];
    const select = this.#db.prepare(
      "SELECT doc FROM assignments WHERE project_id = ? AND id = ?",
    );
    const update = this.#db.prepare(
      "UPDATE assignments SET doc = ?, last_mcp_activity_at = ? WHERE project_id = ? AND id = ?",
    );
    for (const [key, entry] of this.#deferredActivity) {
      try {
        const row = select.get(entry.project_id, entry.assignment_id) as
          | { doc: string }
          | undefined;
        const assignment =
          row === undefined ? undefined : (JSON.parse(row.doc) as Assignment);
        const stored = Date.parse(assignment?.last_mcp_activity_at ?? "");
        if (
          assignment?.status === "active" &&
          (entry.token_id === undefined ||
            assignment.mcp_session_token_id === undefined ||
            entry.token_id === assignment.mcp_session_token_id) &&
          !(Number.isFinite(stored) && stored >= Date.parse(entry.at))
        )
          update.run(
            JSON.stringify({
              ...assignment,
              last_mcp_activity_at: entry.at,
            } satisfies Assignment),
            entry.at,
            entry.project_id,
            entry.assignment_id,
          );
        settled.push([key, entry]);
      } catch {
        // Bookkeeping never fails the transaction it rides along with; the
        // entry stays deferred for the next write.
      }
    }
    return settled;
  }

  /** C-635: the Assignment's dispatched Runs, by index instead of a project-wide scan. */
  dispatchedRunIds(
    project_id: ProjectId,
    assignment_id: AssignmentId,
  ): RunId[] {
    return (
      this.#db
        .prepare(
          "SELECT id FROM runs WHERE project_id = ? AND assignment_id = ? AND json_extract(doc, '$.status') = 'dispatched' ORDER BY rowid",
        )
        .all(project_id, assignment_id) as { id: RunId }[]
    ).map((row) => row.id);
  }

  /**
   * M5.1: the operator's Workbench password (§14). Setting it revokes every
   * open web session, so a stolen cookie dies with the old password.
   */
  setWebPassword(password: string): WebCredential {
    return this.#run(() =>
      setWebPassword(this.#db, password, () => this.#clock.now()),
    );
  }

  /** True once `cardigan web set-password` has run. */
  webPasswordConfigured(): boolean {
    return webPasswordConfigured(this.#db);
  }

  /** Constant-time login check; an unset password never matches. */
  verifyWebLogin(password: string): boolean {
    return verifyWebLogin(this.#db, password);
  }

  /** Create a login session; the plaintext token is returned once. */
  createWebSession(
    options: { readonly ttlMs?: number } = {},
  ): IssuedWebSession {
    return this.#run(() =>
      createWebSession(this.#db, {
        now: () => this.#clock.now(),
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      }),
    );
  }

  /** Live session for a cookie value; `undefined` when unknown/expired/revoked. */
  webSession(token: string): WebSession | undefined {
    return findWebSession(this.#db, token, () => this.#clock.now());
  }

  /** Logout; returns whether a live session was actually revoked. */
  revokeWebSession(token: string): boolean {
    return this.#run(() =>
      revokeWebSession(this.#db, token, () => this.#clock.now()),
    );
  }

  /** Number of sessions that are neither revoked nor logged out (tests/status). */
  countWebSessions(): number {
    return countWebSessions(this.#db);
  }

  #timelineAfter(
    project_id: ProjectId,
    card_id: CardId,
    since_seq: number,
  ): readonly TimelineEntry[] {
    return this.#db
      .prepare(
        "SELECT doc FROM timeline WHERE project_id = ? AND card_id = ? AND event_seq > ? ORDER BY event_seq, id",
      )
      .all(project_id, card_id, since_seq)
      .map((row) => JSON.parse((row as { doc: string }).doc) as TimelineEntry);
  }

  #latestSequence(
    project_id: ProjectId,
    card_id?: CardId | typeof PROJECT_EVENT_STREAM,
  ): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ? AND stream = ?",
      )
      .get(project_id, card_id ?? PROJECT_EVENT_STREAM);
    return Number((row as { seq: number }).seq);
  }

  #cursor(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    card_id: CardId | typeof PROJECT_EVENT_STREAM,
  ): Cursor | undefined {
    const row = this.#db
      .prepare(
        "SELECT doc FROM cursors WHERE project_id = ? AND assignment_id = ? AND card_id = ?",
      )
      .get(project_id, assignment_id, card_id);
    return row === undefined
      ? undefined
      : (JSON.parse((row as { doc: string }).doc) as Cursor);
  }
}

function isSqliteBusy(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === 5
  );
}

/** WAL lock upgrades may return SQLITE_BUSY without invoking SQLite's busy handler. */
function enableWal(db: DatabaseSync): void {
  const deadline = performance.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    for (;;) {
      try {
        db.exec("PRAGMA journal_mode = WAL");
        const journalMode = db
          .prepare("PRAGMA journal_mode")
          .get()?.journal_mode;
        if (journalMode !== "wal")
          throw new Error(
            `SQLite WAL mode required: expected journal_mode=wal, got ${journalMode}`,
          );
        return;
      } catch (error) {
        const remaining = Math.floor(deadline - performance.now());
        if (!isSqliteBusy(error) || remaining <= 0) throw error;
        // Sleep rather than spin, and keep all retries inside the original wait budget.
        Atomics.wait(pause, 0, 0, Math.min(20, remaining));
        const nextWait = Math.floor(deadline - performance.now());
        if (nextWait <= 0) throw error;
        db.exec(`PRAGMA busy_timeout = ${nextWait}`);
      }
    }
  } finally {
    db.exec("PRAGMA busy_timeout = 5000");
  }
}

/** Open a store at `$CARDIGAN_DATA_DIR/cardigan.db` (default `.data/`). */
export function openStore(options: StoreOptions = {}): Store {
  return Store.open(options);
}

/** sha256 over a key-order independent JSON encoding of the request. */
export function hashRequest(request: unknown): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

export type { IssuedToken, IssueTokenInput, TokenRecord, ToolName };
