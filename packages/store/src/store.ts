import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AssignmentId,
  CardId,
  Clock,
  Cursor,
  Event,
  ProjectId,
  Result,
  TimelineEntry,
  ToolName,
  TransactionContext,
  UnitOfWork,
} from "@cardigan/domain";
import { createIdAllocator, PROJECT_EVENT_STREAM } from "./ids.js";
import { type AppliedMigration, migrate } from "./migrate.js";
import {
  createReadRepositories,
  createRepositories,
  type ReadRepositories,
} from "./repositories.js";
import {
  findTokenByHash,
  type IssuedToken,
  type IssueTokenInput,
  issueToken,
  revokeToken,
  type TokenRecord,
  verifyToken,
} from "./tokens.js";

export const DEFAULT_DB_FILE = "cardigan.db";

export interface StoreTransactionContext extends TransactionContext {
  issueToken(input: IssueTokenInput): IssuedToken;
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

export interface StoreOptions {
  /** Directory that holds `cardigan.db`; defaults to `$CARDIGAN_DATA_DIR` or `.data`. */
  readonly dataDir?: string;
  /** Explicit database file, overriding `dataDir`. */
  readonly dbPath?: string;
  readonly clock?: Clock;
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
  readonly card_id: CardId;
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
export class Store {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #migrationsDir: string | undefined;
  #inTransaction = false;

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
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");

    const store = new Store(
      db,
      options.clock ?? systemClock,
      options.migrationsDir,
    );
    try {
      store.migrate();
    } catch (error) {
      db.close();
      throw error;
    }
    return store;
  }

  get database(): DatabaseSync {
    return this.#db;
  }

  migrate(): AppliedMigration[] {
    return migrate(this.#db, this.#migrationsDir, () => this.#clock.now());
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
        this.#run(operation),
      read: <T>(operation: (transaction: ReadRepositories) => T): T =>
        this.#read(operation),
    };
  }

  #run<T>(operation: (transaction: StoreTransactionContext) => T): T {
    if (this.#inTransaction) {
      throw new Error("nested UnitOfWork is not supported");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    let active = true;
    try {
      const result = operation({
        ...createRepositories(this.#db),
        ids: createIdAllocator(this.#db),
        issueToken: (input) => {
          if (!active) throw new Error("Token transaction has ended");
          return issueToken(this.#db, input, () => this.#clock.now());
        },
      });
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
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
    try {
      const result = operation(createReadRepositories(this.#db));
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
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
        card_id: params.card_id,
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
    const request_hash = hashRequest(params.request);
    // The lookup, the operation and the row that records it share one
    // transaction, so a competing writer cannot slip a second execution in.
    return this.#run((tx) => {
      const existing = this.#db
        .prepare(
          "SELECT request_hash, response FROM idempotency " +
            "WHERE project_id = ? AND assignment_id = ? AND key = ?",
        )
        .get(params.project_id, params.assignment_id, params.key) as
        | { request_hash: string; response: string }
        | undefined;

      if (existing !== undefined) {
        if (existing.request_hash !== request_hash) {
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
    };
    this.#db
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
      .run(record.id, record.name, record.created_at);
    return { ok: true, value: record };
  }

  getProject(id: ProjectId): ProjectRecord | undefined {
    const row = this.#db
      .prepare("SELECT id, name, created_at FROM projects WHERE id = ?")
      .get(id) as { id: string; name: string; created_at: string } | undefined;
    return row === undefined
      ? undefined
      : { id: row.id as ProjectId, name: row.name, created_at: row.created_at };
  }

  listProjects(): ProjectRecord[] {
    return this.#db
      .prepare(
        "SELECT id, name, created_at FROM projects ORDER BY created_at, id",
      )
      .all()
      .map((row) => {
        const record = row as { id: string; name: string; created_at: string };
        return {
          id: record.id as ProjectId,
          name: record.name,
          created_at: record.created_at,
        };
      });
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

  #latestSequence(project_id: ProjectId, card_id?: CardId): number {
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
    card_id: CardId,
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
