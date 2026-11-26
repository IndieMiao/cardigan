import {
  type Clock,
  type EarlyConflictProbe,
  earlyConflictDeferral,
  earlyConflictTargets,
  notifyEarlyMergeConflicts,
  type ProjectId,
} from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { runSystemCommand } from "./merge-loop.js";

/** A failed Git probe for the same delivery and baseline waits this long. */
export const EARLY_CONFLICT_RETRY_MS = 60_000;

/** Same path, or one is a directory containing the other (file/directory conflicts). */
export function pathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const set = new Set(right);
  const dirs = (path: string) =>
    path
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const rightDirs = new Set(right.flatMap(dirs));
  return left.some(
    (path) =>
      set.has(path) ||
      rightDirs.has(path) ||
      dirs(path).some((d) => set.has(d)),
  );
}

/**
 * C-782: after main advances, trial-merge delivered heads of cards in review
 * whose changes overlap main's changes since they forked, and tell idle
 * authors about conflicts early. Git work is read-only merge-tree in the central bare repository: no
 * repository or publication lock, ref, index or worktree is touched, so it
 * never waits for, nor holds up, merges or other cards' Git operations.
 */
export class EarlyConflictObserver {
  /** `${project}:${delivery}:${head}:${baseline}` → conflicted paths ([] = clean). */
  private readonly cache = new Map<string, readonly string[]>();
  /** Same key → when its Git probe last failed; retried after `retryMs`. */
  private readonly failed = new Map<string, number>();
  constructor(
    private readonly store: Store,
    private readonly git: MergeGit | undefined,
    private readonly clock: Clock,
    private readonly retryMs = EARLY_CONFLICT_RETRY_MS,
  ) {}
  async tick(project: ProjectId): Promise<void> {
    const git = this.git;
    const binding = git?.projectOf(project);
    if (!git?.trialMerge || !git.baseline || !binding) return;
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const targets = earlyConflictTargets(state, binding.base_branch).filter(
      (t) => !earlyConflictDeferral(state, t),
    );
    const live = new Set<string>();
    let baseline: string | undefined;
    if (targets.length)
      try {
        baseline = await git.baseline(binding);
      } catch {
        /* unavailable baseline: retry next tick */
      }
    const probes: EarlyConflictProbe[] = [];
    for (const target of baseline ? targets : []) {
      const key = `${project}:${target.delivery_id}:${target.head_sha}:${baseline}`;
      live.add(key);
      let files = this.cache.get(key);
      const now = Date.parse(this.clock.now());
      if (
        !files &&
        baseline &&
        !(now < (this.failed.get(key) ?? 0) + this.retryMs)
      )
        try {
          files = await this.probe(binding, baseline, target.head_sha);
          this.cache.set(key, files);
          this.failed.delete(key);
        } catch {
          // No raw Git diagnostics in project events; unknown is not a conflict.
          this.failed.set(key, now);
        }
      if (files?.length) probes.push({ ...target, files });
    }
    // A baseline move during the probes makes them stale; the next tick re-probes.
    let current: string | undefined;
    if (probes.length)
      try {
        current = await git.baseline(binding);
      } catch {
        /* uncertain */
      }
    if (baseline && probes.length && current === baseline) {
      const baseline_sha = baseline;
      runSystemCommand(
        this.store,
        project,
        (fresh, actor, ports) =>
          notifyEarlyMergeConflicts(
            fresh,
            actor,
            { base_branch: binding.base_branch, baseline_sha, probes },
            ports,
          ),
        this.clock,
      );
    }
    for (const map of [this.cache, this.failed])
      for (const key of map.keys())
        if (key.startsWith(`${project}:`) && !live.has(key)) map.delete(key);
  }
  private async probe(
    binding: CentralProject,
    baseline: string,
    head: string,
  ): Promise<readonly string[]> {
    const git = this.git as MergeGit & {
      trialMerge: NonNullable<MergeGit["trialMerge"]>;
    };
    if (git.deliveryChangedPaths) {
      let overlap = true;
      try {
        // Both sides since their merge base: only overlapping paths can conflict.
        const [author, main] = await Promise.all([
          git.deliveryChangedPaths(binding, baseline, head),
          git.deliveryChangedPaths(binding, head, baseline),
        ]);
        overlap = pathsOverlap(author, main);
      } catch {
        /* several merge bases: the trial merge decides */
      }
      if (!overlap) return [];
    }
    return git.trialMerge(binding, baseline, head);
  }
}
