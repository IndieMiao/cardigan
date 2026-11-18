import type { DatabaseSync } from "node:sqlite";
import type { AssignmentId, DeliveryId, ProjectId } from "@cardigan/domain";

/**
 * M4.4: the reconciliation ledger (M4 plan §3.6, development plan §12.6).
 *
 * `reconcile` (git-service) is a pure function: it reports findings and never
 * deletes anything. This module remembers those findings so a persistent orphan
 * keeps its "first seen" age, and a finding that stops appearing is marked
 * resolved rather than forgotten.
 */
export interface ReconcileFindingRecord {
  /** Stable key: kind plus the subject (path / assignment / delivery). */
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
  readonly path?: string;
  readonly assignment_id?: AssignmentId;
  readonly delivery_id?: DeliveryId;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly resolved_at: string | null;
}

/** The subset of a git-service finding the store records (no package coupling). */
export interface ReconcileFindingInput {
  readonly kind: string;
  readonly detail: string;
  readonly path?: string;
  readonly assignment_id?: string;
  readonly delivery_id?: string;
}

/**
 * Findings are keyed by what identifies them, so the same orphan is one row.
 * The detail is deliberately excluded: it may change while the subject does not.
 */
export function findingKey(finding: ReconcileFindingInput): string {
  const subject =
    finding.path ??
    finding.delivery_id ??
    finding.assignment_id ??
    // Kinds without a subject (e.g. a diverged source) are one finding each.
    "";
  return `${finding.kind}:${subject}`;
}

const optional = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

function record(row: Record<string, unknown>): ReconcileFindingRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    detail: String(row.detail),
    ...(optional(row.path) === undefined ? {} : { path: String(row.path) }),
    ...(optional(row.assignment_id) === undefined
      ? {}
      : { assignment_id: String(row.assignment_id) as AssignmentId }),
    ...(optional(row.delivery_id) === undefined
      ? {}
      : { delivery_id: String(row.delivery_id) as DeliveryId }),
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
    resolved_at: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

/**
 * Apply one pass of findings: upsert what was seen, resolve what disappeared.
 * Returns the records that were newly opened (they deserve an event), so a
 * finding that keeps reappearing is not re-announced on every pass.
 */
export function recordFindings(
  db: DatabaseSync,
  project_id: ProjectId,
  findings: readonly ReconcileFindingInput[],
  at: string = new Date().toISOString(),
  options: {
    /**
     * P2a-12 C: path prefixes this pass could not scan (an unreachable
     * executor). Open findings below them stay open with their first-seen
     * time; absence from an incomplete scan is not a resolution.
     */
    readonly unscanned?: readonly string[];
    /** Exact paths whose targeted probes failed, independent of prefix scans. */
    readonly unscannedPaths?: readonly string[];
  } = {},
): { readonly created: readonly ReconcileFindingRecord[] } {
  const created: ReconcileFindingRecord[] = [];
  const seen = new Set<string>();
  const upsert = db.prepare(
    "INSERT INTO reconcile_findings " +
      "(project_id, id, kind, path, assignment_id, delivery_id, detail, first_seen_at, last_seen_at, resolved_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) " +
      "ON CONFLICT (project_id, id) DO UPDATE SET " +
      "detail = excluded.detail, " +
      "first_seen_at = CASE WHEN reconcile_findings.resolved_at IS NULL " +
      "THEN reconcile_findings.first_seen_at ELSE excluded.first_seen_at END, " +
      "last_seen_at = excluded.last_seen_at, resolved_at = NULL",
  );
  const find = db.prepare(
    "SELECT id, kind, path, assignment_id, delivery_id, detail, first_seen_at, last_seen_at, resolved_at " +
      "FROM reconcile_findings WHERE project_id = ? AND id = ?",
  );
  for (const finding of findings) {
    const id = findingKey(finding);
    if (seen.has(id)) continue;
    seen.add(id);
    const before = find.get(project_id, id) as
      | Record<string, unknown>
      | undefined;
    upsert.run(
      project_id,
      id,
      finding.kind,
      finding.path ?? null,
      finding.assignment_id ?? null,
      finding.delivery_id ?? null,
      finding.detail,
      at,
      at,
    );
    // Newly opened, or reopened after being resolved: both deserve attention.
    if (before === undefined || before.resolved_at !== null)
      created.push(record(find.get(project_id, id) as Record<string, unknown>));
  }
  const unscanned = options.unscanned ?? [];
  const unscannedPaths = new Set(options.unscannedPaths ?? []);
  const open = db
    .prepare(
      "SELECT id, path FROM reconcile_findings WHERE project_id = ? AND resolved_at IS NULL",
    )
    .all(project_id)
    .map((row) => row as { id: unknown; path: unknown })
    .filter(
      (row) =>
        typeof row.path !== "string" ||
        (!unscannedPaths.has(row.path) &&
          !unscanned.some((prefix) => (row.path as string).startsWith(prefix))),
    )
    .map((row) => String(row.id));
  const resolve = db.prepare(
    "UPDATE reconcile_findings SET resolved_at = ? WHERE project_id = ? AND id = ? AND resolved_at IS NULL",
  );
  for (const id of open) if (!seen.has(id)) resolve.run(at, project_id, id);
  return { created };
}

/** Findings of a project, newest last; `openOnly` hides resolved ones. */
export function listFindings(
  db: DatabaseSync,
  project_id: ProjectId,
  options: { readonly openOnly?: boolean } = {},
): readonly ReconcileFindingRecord[] {
  const rows = db
    .prepare(
      "SELECT id, kind, path, assignment_id, delivery_id, detail, first_seen_at, last_seen_at, resolved_at " +
        "FROM reconcile_findings WHERE project_id = ?" +
        (options.openOnly ? " AND resolved_at IS NULL" : "") +
        " ORDER BY first_seen_at, id",
    )
    .all(project_id);
  return rows.map((row) => record(row as Record<string, unknown>));
}
