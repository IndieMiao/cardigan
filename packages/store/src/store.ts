import { createHash } from "node:crypto";
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
  NotificationStatus,
  ProjectId,
  ReadMachinePlacement,
  Result,
  TimelineEntry,
  ToolName,
  TransactionContext,
  UnitOfWork,
} from "@cardigan/domain";
import {
  type ChangeCursor,
  type ChangeSet,
  changesSince,
} from "./change-feed.js";
import { CommandEvents } from "./command-events.js";
import {
  CommandSnapshots,
  type SnapshotTransaction,
} from "./command-snapshots.js";
import {
  createGlobalIdAllocator,
  createGlobalRepositories,
} from "./employees.js";
import {
  backupBeforeIdFormatMigration,
  ID_FORMAT_MIGRATION_NAME,
  legacyRequest,
} from "./id-format-migration.js";
import { createIdAllocator, PROJECT_EVENT_STREAM } from "./ids.js";
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
import {
  listFindings,
  type ReconcileFindingInput,
  recordFindings,
} from "./reconcile.js";
import {
  clearRepositoryCache,
  createReadRepositories,
  createRepositories,
  type ReadEventRepository,
  type ReadRepositories,
} from "./repositories.js";
import { backfillStandingModesInTransaction } from "./standing.js";
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
}

function projectRecord(row: {
  id: string;
  name: string;
  created_at: string;
  repo_path: string | null;
  base_branch: string | null;
}): ProjectRecord {
  return {
    id: row.id as ProjectId,
    name: row.name,
    created_at: row.created_at,
    repo_path: row.repo_path,
    base_branch: row.base_branch,
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
}

export interface ProjectCreateInput {
  readonly id: ProjectId;
  readonly name?: string;
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
  /** Whole UnitOfWork, including the state build and domain logic it runs. */
  transaction?(kind: "run" | "read", durationMs: number): void;
  /** A command-state cache miss rebuilt inside a UnitOfWork. */
  stateBuild?(durationMs: number): void;
}

type PlacementReader = (
  tx: ReadRepositories,
  ...args: Parameters<ReadMachinePlacement>
) => ReturnType<ReadMachinePlacement>;

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

  private constructor(db: DatabaseSync, clock: Clock, migrationsDir?: string) {
    this.#db = db;
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
    };
  }

  #run<T>(operation: (transaction: StoreTransactionContext) => T): T {
    if (this.#inTransaction) {
      throw new Error("nested UnitOfWork is not supported");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    let active = true;
    const events = this.#commandEvents.transaction(this.#db);
    const snapshots = this.#snapshots?.transaction();
    try {
      const repositories = createRepositories(this.#db, snapshots);
      const reader = this.#placement;
      const tx: StoreTransactionContext = {
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
        events: { ...repositories.events, listStreams: events.listStreams },
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
      this.#db.exec("COMMIT");
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
        ...this.#cachedState(snapshots),
        ...(this.#testReviewTrust
          ? { test_review_trust: this.#testReviewTrust }
          : {}),
        events: { ...repositories.events, listStreams: events.listStreams },
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
    const record: ProjectRecord = {
      id: input.id,
      name: input.name ?? input.id,
      created_at: this.#clock.now(),
      repo_path: null,
      base_branch: null,
    };
    this.uow.run(() => {
      this.#db
        .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
        .run(record.id, record.name, record.created_at);
      seedCardTemplates(this.#db, record.id);
      if (this.schemaVersion() >= 26)
        seedLocalMachine(this.#db, record.id, record.created_at);
    });
    return { ok: true, value: record };
  }

  getProject(id: ProjectId): ProjectRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT id, name, created_at, repo_path, base_branch FROM projects WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          name: string;
          created_at: string;
          repo_path: string | null;
          base_branch: string | null;
        }
      | undefined;
    return row === undefined ? undefined : projectRecord(row);
  }

  listProjects(): ProjectRecord[] {
    return this.#db
      .prepare(
        "SELECT id, name, created_at, repo_path, base_branch FROM projects ORDER BY created_at, id",
      )
      .all()
      .map((row) =>
        projectRecord(
          row as {
            id: string;
            name: string;
            created_at: string;
            repo_path: string | null;
            base_branch: string | null;
          },
        ),
      );
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
   */
  touchAssignmentActivity(
    project_id: ProjectId,
    assignment_id: AssignmentId,
    at: string = this.#clock.now(),
  ): boolean {
    return this.#run(() => {
      const row = this.#db
        .prepare("SELECT doc FROM assignments WHERE project_id = ? AND id = ?")
        .get(project_id, assignment_id) as { doc: string } | undefined;
      if (row === undefined) return false;
      const assignment = JSON.parse(row.doc) as Assignment;
      if (assignment.status !== "active") return false;
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
        if (
          !error ||
          typeof error !== "object" ||
          !("errcode" in error) ||
          typeof error.errcode !== "number" ||
          (error.errcode & 0xff) !== 5 ||
          remaining <= 0
        )
          throw error;
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
