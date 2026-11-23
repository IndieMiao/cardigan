import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "@cardigan/store";
import {
  type CapacityOwnerRow,
  capacityMachine,
  capacityOwnerState,
} from "./capacity-owner.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

/**
 * C-609: managed long operations an automatic deployment waits for before it
 * stops the server. Merge checks and author prechecks are fenced separately by
 * the check capacity tables; GitHub runs survive a restart once bound.
 */
export type LongOperationKind =
  | "mobile_signing"
  | "artifact_publication"
  | "worker_upgrade";

export interface LongOperation {
  readonly id: string;
  /** Kinds written by a newer server are still waited for. */
  readonly kind: LongOperationKind | (string & {});
  readonly project_id: string;
  readonly card_id: string | null;
  readonly label: string;
  readonly started_at: string;
}

/**
 * A fence older than this no longer holds new operations back, even if its
 * owner cannot be proven dead: a deployment never stops operations for good.
 */
export const LONG_OPERATION_FENCE_MAX_MS = 30 * 60 * 1000;
/** How often an operation waiting at the fence looks again. */
export const LONG_OPERATION_FENCE_POLL_MS = 1_000;

type FenceRow = CapacityOwnerRow & { since: string };

function fenceStands(store: Store, now: number): boolean {
  const row = store.database
    .prepare(
      "SELECT owner_pid, owner_start, owner_machine, since FROM host_long_operation_fence WHERE singleton = 1",
    )
    .get() as FenceRow | undefined;
  if (!row) return false;
  const age = now - Date.parse(row.since);
  if (
    capacityOwnerState(row) !== "dead" &&
    age >= 0 &&
    age < LONG_OPERATION_FENCE_MAX_MS
  )
    return true;
  store.database
    .prepare(
      "DELETE FROM host_long_operation_fence WHERE singleton = 1 AND owner_pid = ? AND owner_start = ? AND since = ?",
    )
    .run(row.owner_pid, row.owner_start, row.since);
  return false;
}

/**
 * Register an operation and return its idempotent, never-throwing release.
 * While a deployment's stop fence stands the registration waits, so the
 * operation either runs before the stop decision (and is waited for or
 * recorded) or never starts on this server and runs on the next one.
 *
 * Best effort otherwise: a missing table (older schema), an unavailable
 * process identity or a failed write never fails the operation itself.
 */
export async function holdLongOperation(
  store: Store,
  operation: {
    readonly kind: LongOperationKind;
    readonly project_id: string;
    readonly card_id?: string | null | undefined;
    readonly label: string;
  },
  options: {
    readonly owner?: ExecutionOwner | undefined;
    readonly now?: () => string;
    readonly pollMs?: number;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<() => void> {
  let id: string | undefined;
  for (;;) {
    let fenced = false;
    try {
      const owner = options.owner ?? executionOwner(process.pid);
      if (!owner) return () => {};
      const row = randomUUID();
      const machine = capacityMachine();
      const at = options.now?.() ?? new Date().toISOString();
      fenced = store.uow.run(() => {
        if (fenceStands(store, Date.parse(at))) return true;
        store.database
          .prepare(
            `INSERT INTO host_long_operations
            (id, kind, project_id, card_id, label, started_at, owner_pid, owner_start, owner_machine)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row,
            operation.kind,
            operation.project_id,
            operation.card_id ?? null,
            operation.label.slice(0, 200),
            at,
            owner.pid,
            owner.start,
            machine,
          );
        return false;
      });
      if (!fenced) id = row;
    } catch {
      return () => {};
    }
    if (!fenced) break;
    await delay(options.pollMs ?? LONG_OPERATION_FENCE_POLL_MS, undefined, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  return () => {
    const row = id;
    id = undefined;
    if (!row) return;
    try {
      store.uow.run(() => {
        store.database
          .prepare("DELETE FROM host_long_operations WHERE id = ?")
          .run(row);
      });
    } catch {
      /* A stale row is reclaimed once its owner is proven dead. */
    }
  };
}

/** Hold for the lifetime of `work`, including when it rejects. */
export async function withLongOperation<T>(
  store: Store,
  operation: Parameters<typeof holdLongOperation>[1],
  work: () => Promise<T>,
): Promise<T> {
  const release = await holdLongOperation(store, operation);
  try {
    return await work();
  } finally {
    release();
  }
}

/** Caller holds the transaction. Deletes rows of proven-dead owners. */
function readLive(store: Store): LongOperation[] {
  const rows = store.database
    .prepare(
      `SELECT id, kind, project_id, card_id, label, started_at, owner_pid, owner_start, owner_machine
      FROM host_long_operations ORDER BY started_at, id`,
    )
    .all() as unknown as (LongOperation & CapacityOwnerRow)[];
  const live: LongOperation[] = [];
  for (const row of rows) {
    if (capacityOwnerState(row) === "dead") {
      store.database
        .prepare("DELETE FROM host_long_operations WHERE id = ?")
        .run(row.id);
      continue;
    }
    live.push({
      id: row.id,
      kind: row.kind,
      project_id: row.project_id,
      card_id: row.card_id ?? null,
      label: row.label,
      started_at: row.started_at,
    });
  }
  return live;
}

/**
 * Operations whose owner is alive or cannot be proven dead, oldest first.
 * Rows of proven-dead owners are deleted. Never throws: an unreadable registry
 * reads as empty, so it can only shorten, never extend, a deployment wait.
 */
export function liveLongOperations(store: Store): LongOperation[] {
  try {
    return store.uow.run(() => readLive(store));
  } catch {
    return [];
  }
}

/**
 * The deployment's stop decision: in one transaction, close the start of new
 * operations and return those still running. Never throws; without a fence
 * table or process identity it degrades to a plain read.
 */
export function fenceLongOperations(
  store: Store,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
  now: () => string = () => new Date().toISOString(),
): LongOperation[] {
  if (!owner) return liveLongOperations(store);
  try {
    return store.uow.run(() => {
      store.database
        .prepare(
          `INSERT OR REPLACE INTO host_long_operation_fence
          (singleton, owner_pid, owner_start, owner_machine, since) VALUES (1, ?, ?, ?, ?)`,
        )
        .run(owner.pid, owner.start, capacityMachine(), now());
      return readLive(store);
    });
  } catch {
    return liveLongOperations(store);
  }
}

/** Reopen the start of operations; only the fence's own owner removes it. */
export function releaseLongOperationFence(
  store: Store,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
): void {
  if (!owner) return;
  try {
    store.uow.run(() => {
      store.database
        .prepare(
          "DELETE FROM host_long_operation_fence WHERE singleton = 1 AND owner_pid = ? AND owner_start = ?",
        )
        .run(owner.pid, owner.start);
    });
  } catch {
    /* The fence expires with its owner or its age limit. */
  }
}

/**
 * C-609: a worker upgrade stays registered until the machine check journal
 * settles its final result, after the patrol itself has returned.
 */
const settlingHolds = new Map<string, () => void>();

/** Keep `release` pending until `releaseSettlingHold(job)`. */
export function keepUntilSettled(job: string, release: () => void): void {
  settlingHolds.get(job)?.();
  settlingHolds.set(job, release);
}

/** Called once the journal has recorded the job's final result. */
export function releaseSettlingHold(job: string): void {
  const release = settlingHolds.get(job);
  settlingHolds.delete(job);
  release?.();
}
