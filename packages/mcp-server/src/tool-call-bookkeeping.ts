import type { Assignment, AssignmentId, ProjectId } from "@cardigan/domain";
import type { Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";
import { acknowledgeDispatchedRun } from "./commands/acknowledge.js";
import type { Logger } from "./log.js";

/**
 * C-635: default spacing of one session's MCP activity writes. Every
 * threshold that reads `last_mcp_activity_at` is at least 60 s (client
 * recovery 60 s; inactivity alerts, stop deadlines and idle retirement are
 * minutes). A call inside the interval is written no later than the recorded
 * time plus the interval, so while the record lags, it is less than one
 * interval old: "silent for at least T" is decided as before for every T ≥ it.
 */
export const DEFAULT_ACTIVITY_WRITE_INTERVAL_MS = 30_000;
/**
 * C-635: the longest a woken session's first call waits for a write to ride
 * along with (usually its own handler's). Before C-635 this write could wait
 * seconds for the lock while the event loop was frozen.
 */
export const ACTIVITY_WAKE_DELAY_MS = 1_000;
/** Backoff of deferred writes after a busy database, capped. */
const RETRY_BASE_MS = 50;
const RETRY_MAX_MS = 1_000;

export interface ToolCallTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: ToolCallTimers = {
  set: (callback, ms) => setTimeout(callback, ms).unref(),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ToolCallBookkeepingOptions {
  readonly store: McpBackend;
  /** `false` disables the M2.6 Run acknowledgement (tests of pure routing). */
  readonly acknowledgeRuns?: boolean;
  /** Minimum spacing of one session's activity writes. */
  readonly activityWriteIntervalMs?: number;
  readonly now?: () => number;
  readonly timers?: ToolCallTimers;
  readonly log?: Logger;
}

interface PendingHandshake {
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly key_sha256: string | undefined;
  readonly token_id: string;
}

/**
 * C-635: the writes that precede every Card MCP tool call — the C-600
 * handshake, the Assignment's last activity and the M2.6 Run acknowledgement.
 *
 * None of them waits for another process's write lock on the tool-call path:
 * node:sqlite is synchronous, so such a wait froze the whole web event loop.
 * A write the database refuses as busy is decided now, kept in memory and
 * retried from a timer with a capped backoff.
 *
 * - The handshake and the acknowledgement change once per session or Run;
 *   other calls only read.
 * - The activity time is deferred in the store and rides along with the next
 *   write transaction of this process (often the call's own handler). Only
 *   when none came by its deadline is a write of its own made: within
 *   `ACTIVITY_WAKE_DELAY_MS` for a session whose record is older than the
 *   interval, otherwise at the recorded time plus the interval. One such
 *   write carries every deferred session.
 * - Per Assignment and Token, a deferred handshake is written before the
 *   acknowledgement it unlocks. Every deferred write repeats its checks
 *   (active Assignment, the session's own Token, state still pending) inside
 *   its own transaction, so a replaced session's late call never counts.
 */
export class ToolCallBookkeeping {
  readonly #store: McpBackend;
  readonly #acknowledge: boolean;
  readonly #interval: number;
  readonly #now: () => number;
  readonly #timers: ToolCallTimers;
  readonly #log: Logger | undefined;
  /** Deadline of each session's deferred activity. */
  readonly #due = new Map<string, number>();
  readonly #handshakes = new Map<string, PendingHandshake>();
  readonly #acks = new Map<string, Identity>();
  #timer: unknown;
  #timerAt = Number.POSITIVE_INFINITY;
  #failures = 0;
  #notBefore = 0;
  #closed = false;

  constructor(options: ToolCallBookkeepingOptions) {
    this.#store = options.store;
    this.#acknowledge = options.acknowledgeRuns !== false;
    this.#interval =
      options.activityWriteIntervalMs ?? DEFAULT_ACTIVITY_WRITE_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
    this.#log = options.log;
  }

  /** Writes still waiting for a ride, a slot or the database (tests, diagnostics). */
  get pending(): number {
    const activity = this.#store.deferredAssignmentActivity?.().length ?? 0;
    return activity + this.#handshakes.size + this.#acks.size;
  }

  /**
   * The C-600 handshake of a tool call. Returns the session's state; a state
   * decided while the database is busy is returned at once and written later.
   */
  handshake(identity: Identity, key_sha256: string | undefined) {
    const { project_id, assignment_id } = identity.actor;
    const store = this.#store;
    if (!store.tryAdvanceMcpHandshake)
      return store.advanceMcpHandshake?.(
        project_id,
        assignment_id,
        "tool_called",
        key_sha256,
        identity.token.id,
      );
    const result = store.tryAdvanceMcpHandshake(
      project_id,
      assignment_id,
      "tool_called",
      key_sha256,
      identity.token.id,
    );
    if (!result.persisted) {
      this.#handshakes.set(keyOf(identity), {
        project_id,
        assignment_id,
        key_sha256,
        token_id: identity.token.id,
      });
      this.#busy();
    }
    return result.state;
  }

  /**
   * Activity and acknowledgement of an admitted tool call. Returns how many
   * write transactions it attempted on the caller's path (for the tool log).
   * Errors other than a busy database are thrown, as before.
   */
  toolCalled(identity: Identity): number {
    const store = this.#store;
    if (
      !store.withoutLockWait ||
      !store.deferAssignmentActivity ||
      !store.flushDeferredActivity
    )
      return this.#legacy(identity);
    this.#deferActivity(identity);
    let writes = 0;
    if (this.#acknowledge) {
      const key = keyOf(identity);
      if (this.#handshakes.has(key) || this.#acks.has(key)) {
        this.#acks.set(key, identity);
      } else if (this.#hasDispatchedRun(identity)) {
        // Also carries the deferred activity.
        writes++;
        const attempt = store.withoutLockWait(() =>
          acknowledgeDispatchedRun(store, identity),
        );
        if (attempt.busy) {
          this.#acks.set(key, identity);
          this.#busy();
        }
      }
    }
    this.#arm();
    return writes;
  }

  /** Stop the timer and make one last attempt at everything deferred. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    try {
      this.#flush(true);
    } catch {
      this.#log?.({ event: "tool_bookkeeping", code: "close_failed" });
    }
    this.#clearTimer();
  }

  #legacy(identity: Identity): number {
    const { project_id, assignment_id } = identity.actor;
    this.#store.touchAssignmentActivity?.(
      project_id,
      assignment_id,
      undefined,
      identity.token.id,
    );
    if (this.#acknowledge) acknowledgeDispatchedRun(this.#store, identity);
    return 2;
  }

  #hasDispatchedRun(identity: Identity): boolean {
    const { project_id, assignment_id } = identity.actor;
    // Without the indexed lookup the acknowledgement does its own scan.
    return (
      this.#store.dispatchedRunIds?.(project_id, assignment_id).length !== 0
    );
  }

  #deferActivity(identity: Identity): void {
    const store = this.#store;
    const { project_id, assignment_id } = identity.actor;
    const token_id = identity.token.id;
    const assignment = store.uow.read((tx) =>
      tx.assignments.get(project_id, assignment_id),
    );
    // The same rules as the write itself, which rechecks them.
    if (!assignment || !ownActiveSession(assignment, token_id)) return;
    const now = this.#now();
    const stored = Date.parse(assignment.last_mcp_activity_at ?? "");
    // Already recorded at or after this call.
    if (Number.isFinite(stored) && stored >= now) return;
    const due =
      Number.isFinite(stored) && now - stored < this.#interval
        ? stored + this.#interval
        : now + ACTIVITY_WAKE_DELAY_MS;
    store.deferAssignmentActivity?.({
      project_id,
      assignment_id,
      token_id,
      at: new Date(now).toISOString(),
    });
    const key = keyOf(identity);
    this.#due.set(key, Math.min(this.#due.get(key) ?? due, due));
  }

  #flush(all = false): void {
    const store = this.#store;
    const now = this.#now();
    let busy = false;
    let writes = 0;
    for (const [key, h] of this.#handshakes) {
      writes++;
      const result = store.tryAdvanceMcpHandshake?.(
        h.project_id,
        h.assignment_id,
        "tool_called",
        h.key_sha256,
        h.token_id,
      );
      if (result && !result.persisted) {
        busy = true;
        break;
      }
      this.#handshakes.delete(key);
    }
    if (!busy) {
      // Forget sessions whose activity already rode along with another write.
      const deferred = new Set(
        (store.deferredAssignmentActivity?.() ?? []).map((entry) =>
          JSON.stringify([
            entry.project_id,
            entry.assignment_id,
            entry.token_id ?? null,
          ]),
        ),
      );
      for (const key of this.#due.keys())
        if (!deferred.has(key)) this.#due.delete(key);
      if (
        deferred.size > 0 &&
        (all || [...this.#due.values()].some((due) => due <= now))
      ) {
        writes++;
        const attempt = store.withoutLockWait?.(
          () => store.flushDeferredActivity?.() ?? 0,
        );
        if (attempt?.busy) busy = true;
        else this.#due.clear();
      }
    }
    if (!busy)
      for (const [key, identity] of this.#acks) {
        if (this.#handshakes.has(key)) continue;
        writes++;
        let attempt: { busy: boolean } | undefined;
        try {
          attempt = store.withoutLockWait?.(() =>
            acknowledgeDispatchedRun(store, identity),
          );
        } catch (error) {
          // Not retried: the next tool call of the session tries again.
          this.#log?.({
            event: "tool_bookkeeping",
            assignment_id: identity.actor.assignment_id,
            code:
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code: unknown }).code)
                : "acknowledge_failed",
          });
        }
        if (attempt?.busy) {
          busy = true;
          break;
        }
        this.#acks.delete(key);
      }
    if (writes > 0)
      this.#log?.({
        event: "tool_bookkeeping",
        code: busy ? "busy" : "ok",
        writes,
        pending: this.pending,
        duration_ms: this.#now() - now,
      });
    if (busy) this.#busy();
    else {
      this.#failures = 0;
      this.#notBefore = 0;
      this.#arm();
    }
  }

  #busy(): void {
    this.#failures++;
    this.#notBefore =
      this.#now() +
      Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.#failures - 1));
    this.#arm();
  }

  #arm(): void {
    if (this.#closed) return;
    let due = Number.POSITIVE_INFINITY;
    for (const at of this.#due.values()) due = Math.min(due, at);
    if (this.#handshakes.size > 0 || this.#acks.size > 0)
      due = Math.min(due, this.#now());
    if (due === Number.POSITIVE_INFINITY) {
      this.#clearTimer();
      return;
    }
    due = Math.max(due, this.#notBefore);
    if (this.#timer !== undefined && this.#timerAt <= due) return;
    this.#clearTimer();
    this.#timerAt = due;
    this.#timer = this.#timers.set(
      () => {
        this.#timer = undefined;
        this.#timerAt = Number.POSITIVE_INFINITY;
        try {
          this.#flush();
        } catch {
          // Not a busy database: retrying would fail the same way. The
          // next tool call of each session records its own activity again.
          this.#log?.({ event: "tool_bookkeeping", code: "flush_failed" });
          this.#due.clear();
          this.#handshakes.clear();
          this.#acks.clear();
          this.#failures = 0;
          this.#notBefore = 0;
        }
      },
      Math.max(0, due - this.#now()),
    );
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Number.POSITIVE_INFINITY;
  }
}

/** The store keys deferred activity the same way. */
function keyOf(identity: Identity): string {
  return JSON.stringify([
    identity.actor.project_id,
    identity.actor.assignment_id,
    identity.token.id,
  ]);
}

/** C-600: only an active Assignment's own session records activity. */
function ownActiveSession(a: Assignment, token_id: string): boolean {
  return (
    a.status === "active" &&
    (a.mcp_session_token_id === undefined ||
      a.mcp_session_token_id === token_id)
  );
}
