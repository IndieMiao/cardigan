import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Store } from "./store.js";

/**
 * C-797: snapshots no live session has refreshed for this long are dropped. A
 * session whose snapshot is gone counts as "difference unreadable" and is
 * replaced once, so pruning can only cost a restart, never skip one.
 */
export const TOOL_CATALOG_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Keep the structure behind `fingerprint`, refreshing `recorded_at`, and drop
 * snapshots older than the retention. Rejects a structure that does not hash
 * to its fingerprint.
 */
export function recordToolCatalogSnapshot(
  store: Store,
  fingerprint: string,
  structure: string,
  now: string,
): void {
  if (digest(structure) !== fingerprint)
    throw new Error("tool catalog structure does not match its fingerprint");
  const cutoff = new Date(
    Date.parse(now) - TOOL_CATALOG_SNAPSHOT_RETENTION_MS,
  ).toISOString();
  // Two independent statements: no UnitOfWork, so a caller already inside
  // one may record too. Losing either only ever costs a later restart.
  store.database
    .prepare(
      "INSERT INTO tool_catalog_snapshots (fingerprint, structure, recorded_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(fingerprint) DO UPDATE SET recorded_at = excluded.recorded_at",
    )
    .run(fingerprint, gzipSync(structure), now);
  store.database
    .prepare("DELETE FROM tool_catalog_snapshots WHERE recorded_at < ?")
    .run(cutoff);
}

/**
 * The structure behind `fingerprint`, or undefined when it was never kept,
 * was pruned, or no longer hashes to the fingerprint.
 */
export function readToolCatalogSnapshot(
  store: Store,
  fingerprint: string,
): string | undefined {
  const row = store.database
    .prepare(
      "SELECT structure FROM tool_catalog_snapshots WHERE fingerprint = ?",
    )
    .get(fingerprint);
  if (!row || !(row.structure instanceof Uint8Array)) return undefined;
  let structure: string;
  try {
    structure = gunzipSync(row.structure).toString("utf8");
  } catch {
    return undefined;
  }
  return digest(structure) === fingerprint ? structure : undefined;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
