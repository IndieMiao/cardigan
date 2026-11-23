import { randomUUID } from "node:crypto";
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
 * Best effort: a missing table (older schema), an unavailable process identity
 * or a failed write never fails or delays the operation itself. The returned
 * release is idempotent and never throws.
 */
export function holdLongOperation(
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
  } = {},
): () => void {
  let id: string | undefined;
  try {
    const owner = options.owner ?? executionOwner(process.pid);
    if (!owner) return () => {};
    const row = randomUUID();
    const machine = capacityMachine();
    store.uow.run(() => {
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
          options.now?.() ?? new Date().toISOString(),
          owner.pid,
          owner.start,
          machine,
        );
    });
    id = row;
  } catch {
    return () => {};
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
  const release = holdLongOperation(store, operation);
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Operations whose owner is alive or cannot be proven dead, oldest first.
 * Rows of proven-dead owners are deleted. Never throws: an unreadable registry
 * reads as empty, so it can only shorten, never extend, a deployment wait.
 */
export function liveLongOperations(store: Store): LongOperation[] {
  try {
    return store.uow.run(() => {
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
    });
  } catch {
    return [];
  }
}
