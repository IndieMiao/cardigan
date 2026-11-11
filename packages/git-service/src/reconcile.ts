import { join, resolve } from "node:path";
import type {
  Assignment,
  Delivery,
  GitWorktree,
  MergeCheckView,
} from "@cardigan/domain";
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
  | "source_diverged"
  /** P2a-12 C: a merge-check executor's directories could not be listed. */
  | "executor_unreachable";

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
  readonly checks_root?: string;
  /** Worktrees registered in the base clone. */
  readonly registered: readonly GitWorktree[];
  /** Existing assignment/check directories, including registered paths outside those roots. */
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

/** Allow one default reconciliation interval for the check's own cleanup. */
export const DEFAULT_CHECK_CLEANUP_GRACE_MS = 600_000;
export interface ReconcileChecks {
  readonly attempts: readonly Pick<
    MergeCheckView,
    "attempt_id" | "status" | "updated_at"
  >[];
  readonly now: string;
  readonly cleanupGraceMs?: number;
}

export function reconcile(
  state: WorktreeState,
  assignments: readonly Assignment[],
  deliveries: readonly Delivery[],
  checks?: ReconcileChecks,
): readonly ReconcileFinding[] {
  const owned = new Set(
      assignments
        .filter((assignment) => assignment.worktree_path)
        .map((assignment) => resolve(assignment.worktree_path as string)),
    ),
    registered = new Set(state.registered.map((entry) => resolve(entry.path))),
    directories = new Set(state.directories.map((entry) => resolve(entry))),
    findings: ReconcileFinding[] = [];

  const attempts = new Map(
    state.checks_root && checks
      ? checks.attempts
          .filter((check) =>
            /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(check.attempt_id),
          )
          .map(
            (check) =>
              [
                resolve(
                  join(
                    state.checks_root as string,
                    check.attempt_id,
                    "worktree",
                  ),
                ),
                check,
              ] as const,
          )
      : [],
  );
  const protectedChecks = new Set(
    [...attempts]
      .filter(
        ([, check]) =>
          check.status === "queued" ||
          check.status === "running" ||
          Date.parse(checks?.now ?? "") - Date.parse(check.updated_at) <=
            (checks?.cleanupGraceMs ?? DEFAULT_CHECK_CLEANUP_GRACE_MS),
      )
      .map(([path]) => path),
  );

  // Presence decides the finding: a missing registration cannot also be an orphan.
  for (const path of sorted(directories))
    if (!owned.has(path) && !protectedChecks.has(path))
      findings.push({
        kind: "orphan_worktree",
        detail: attempts.has(path)
          ? `Finished merge check ${attempts.get(path)?.attempt_id} left a directory after cleanup grace; Git registration ${registered.has(path) ? "present" : "missing"}`
          : "Worktree exists but no Assignment owns it",
        path,
      });
  // Git registered it, the directory is gone: the base clone needs pruning.
  for (const path of sorted(registered))
    if (!directories.has(path) && !protectedChecks.has(path))
      findings.push({
        kind: "stale_registration",
        detail: attempts.has(path)
          ? `Finished merge check ${attempts.get(path)?.attempt_id} left a Git registration after cleanup grace; directory missing`
          : "Worktree is registered in Git but its directory is missing",
        path,
      });
  // §3.6: a worktree is "missing" when its directory is gone, whatever Git
  // still has registered. The database owns the directory, so this is the
  // finding that tells PM Ops *which* Assignment lost its workspace; a leftover
  // registration is reported separately above, for pruning.
  for (const assignment of assignments) {
    if (assignment.status !== "active" || !assignment.worktree_path) continue;
    const path = resolve(assignment.worktree_path);
    if (directories.has(path)) continue;
    findings.push({
      kind: "missing_worktree",
      detail: "Active Assignment has no worktree directory",
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

/**
 * P2a-12 C: the check directories of one project on a non-local merge-check
 * executor, listed over that executor's SSH entry. `unreachable` means the
 * listing failed; it is never evidence that a directory is gone.
 */
export interface ExecutorCheckState {
  readonly executor: string;
  /** `<agent_root>/checks/<project>` on the executor machine. */
  readonly checks_root: string;
  readonly listing:
    | {
        readonly status: "listed";
        /** Existing `<attempt>/worktree` directories. */
        readonly directories: readonly string[];
        /** Registrations of the executor's base clone below `checks_root`. */
        readonly registered: readonly string[];
      }
    | { readonly status: "unreachable" };
}

/**
 * Same Store-driven judgement as the local scan (queued/running and the
 * cleanup grace are protected), for directories on another machine. Paths are
 * reported as `<executor>:<path>` so they never collide with host paths.
 */
export function reconcileExecutorChecks(
  state: ExecutorCheckState,
  project_id: string,
  checks?: ReconcileChecks,
): readonly ReconcileFinding[] {
  if (state.listing.status === "unreachable")
    return [
      {
        kind: "executor_unreachable",
        detail: `Merge check executor ${state.executor} is unreachable; its check directories were not scanned, so no orphan or stale registration is reported for them`,
        path: `${state.executor}:${state.checks_root}`,
      },
    ];
  const root = resolve(state.checks_root),
    below = (path: string) => resolve(path).startsWith(`${root}/`);
  return reconcile(
    {
      project_id,
      worktrees_root: root,
      checks_root: root,
      registered: state.listing.registered
        .filter(below)
        .map((path) => ({ path, head: "" })),
      directories: state.listing.directories.filter(below),
      failed_clones: [],
      pinned: [],
    },
    [],
    [],
    checks,
  ).map((finding) => ({
    ...finding,
    detail: `Executor ${state.executor}: ${finding.detail}`,
    ...(finding.path === undefined
      ? {}
      : { path: `${state.executor}:${finding.path}` }),
  }));
}
