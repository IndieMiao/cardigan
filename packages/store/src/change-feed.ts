import type { DatabaseSync } from "node:sqlite";
import type { ProjectId } from "@cardigan/domain";
import { prepare } from "./statements.js";

/**
 * C-244: where a consumer of the change feed last looked — the committed
 * revision of each collection it follows.
 */
export interface ChangeCursor {
  readonly project_id: ProjectId;
  readonly versions: ReadonlyMap<string, number>;
}

export interface ChangeSet {
  /** Commit this only after the work that consumed the changes committed. */
  readonly cursor: ChangeCursor;
  /**
   * Changed row ids per collection since the given cursor (inserted, updated
   * or deleted). `undefined` means "start over": there was no cursor, or a
   * revision went backwards, so the consumer must rebuild from the full state.
   */
  readonly changed: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}

/**
 * Read the row change feed kept by the snapshot triggers (0017) and the inbox
 * triggers (0023). Call it inside the transaction that also loads the state
 * the consumer evaluates, so both see the same committed revision.
 *
 * Every collection here must have a single-column key (`id`).
 */
export function changesSince(
  db: DatabaseSync,
  project: ProjectId,
  collections: readonly string[],
  since: ChangeCursor | undefined,
): ChangeSet {
  const versions = new Map<string, number>();
  for (const row of prepare(
    db,
    `SELECT collection, version FROM command_versions
      WHERE project_id = ? AND collection IN (SELECT value FROM json_each(?))`,
  ).all(project, JSON.stringify(collections)))
    versions.set(String(row.collection), Number(row.version));
  const cursor: ChangeCursor = { project_id: project, versions };
  if (!since || since.project_id !== project)
    return { cursor, changed: undefined };
  const changed = new Map<string, Set<string>>();
  for (const collection of collections) {
    const before = since.versions.get(collection) ?? 0;
    const now = versions.get(collection) ?? 0;
    if (now < before) return { cursor, changed: undefined };
    if (now === before) continue;
    const ids = new Set<string>();
    for (const row of prepare(
      db,
      `SELECT entity_key FROM command_rows
        WHERE project_id = ? AND collection = ? AND version > ?`,
    ).all(project, collection, before)) {
      const key = JSON.parse(String(row.entity_key)) as unknown[];
      ids.add(String(key[0]));
    }
    changed.set(collection, ids);
  }
  return { cursor, changed };
}
