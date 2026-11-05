import { resolve } from "node:path";
import type { Assignment, Delivery, GitWorktree } from "@cardigan/domain";
import type { SourceSync } from "./central.js";

/**
 * §3.6 reconciliation: compare what Git knows, what the host directory shows and
 * what the database records. This module never touches the filesystem or Git —
 * `GitWorktreeService.listWorktreeState` gathers the state and `reconcile`
 * reports findings, so no finding can ever delete anything.
 */
export type ReconcileFindingKind =
  | "orphan_worktree"
  | "missing_worktree"
  | "stale_registration"
  | "missing_delivery_ref"
  | "failed_clone"
  | "source_diverged";

export interface ReconcileFinding {
  readonly kind: ReconcileFindingKind;
  /** Human-readable summary; the CLI prints it as is. */
  readonly detail: string;
  readonly path?: string;
  readonly assignment_id?: string;
  readonly delivery_id?: string;
}
export interface WorktreeState {
  readonly project_id: string;
  readonly worktrees_root: string;
  /** Worktrees registered in the base clone. */
  readonly registered: readonly GitWorktree[];
  /** Directories that actually exist under the worktree root. */
  readonly directories: readonly string[];
  /** Failed staging clones left behind by M2.7 (`.clone-*` in the clone root). */
  readonly failed_clones: readonly string[];
  /** Present only when the central repository exists. */
  readonly source_sync?: SourceSync;
  /** `refs/cardigan/deliveries/<delivery_id>` of the central repository. */
  readonly pinned: readonly {
    readonly delivery_id: string;
    readonly sha: string;
  }[];
}

const sorted = (values: Iterable<string>) => [...values].sort();

export function reconcile(
  state: WorktreeState,
  assignments: readonly Assignment[],
  deliveries: readonly Delivery[],
): readonly ReconcileFinding[] {
  const owned = new Set(
      assignments
        .filter((assignment) => assignment.worktree_path)
        .map((assignment) => resolve(assignment.worktree_path as string)),
    ),
    registered = new Set(state.registered.map((entry) => resolve(entry.path))),
    directories = new Set(state.directories.map((entry) => resolve(entry))),
    findings: ReconcileFinding[] = [];

  // A path Git knows or the filesystem shows, but no Assignment owns.
  for (const path of sorted(new Set([...registered, ...directories])))
    if (!owned.has(path))
      findings.push({
        kind: "orphan_worktree",
        detail: "Worktree exists but no Assignment owns it",
        path,
      });
  // Git registered it, the directory is gone: the base clone needs pruning.
  for (const path of sorted(registered))
    if (!directories.has(path))
      findings.push({
        kind: "stale_registration",
        detail: "Worktree is registered in Git but its directory is missing",
        path,
      });
  // An active Assignment expects a worktree that is neither registered nor present.
  for (const assignment of assignments) {
    if (assignment.status !== "active" || !assignment.worktree_path) continue;
    const path = resolve(assignment.worktree_path);
    if (!registered.has(path) && !directories.has(path))
      findings.push({
        kind: "missing_worktree",
        detail: "Active Assignment has no worktree",
        path,
        assignment_id: assignment.id,
      });
  }
  // A delivered Git commit must stay reachable through its fixed ref.
  const pinned = new Map(
    state.pinned.map((entry) => [entry.delivery_id, entry.sha]),
  );
  for (const delivery of [...deliveries].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (delivery.subject.kind !== "git_head") continue;
    if (pinned.get(delivery.id) !== delivery.subject.value)
      findings.push({
        kind: "missing_delivery_ref",
        detail: "Git delivery has no matching fixed ref",
        delivery_id: delivery.id,
      });
  }
  for (const path of sorted(state.failed_clones))
    findings.push({
      kind: "failed_clone",
      detail: "Failed staging clone left in the clone root",
      path,
    });
  if (state.source_sync === "diverged")
    findings.push({
      kind: "source_diverged",
      detail: "Registered source and central baseline diverged",
    });
  return findings;
}
