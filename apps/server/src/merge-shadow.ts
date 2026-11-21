import {
  type Clock,
  currentPreMergeVersions,
  type DecisionId,
  eventsForDecision,
  type MergeShadowPaths,
  type ProjectId,
  prepareMergeShadow,
  projectPreferences,
  validMergeShadowPolicy,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import {
  applyMaintenancePlan,
  type MaintenanceWrite,
} from "./maintenance-writes.js";

/** Collect Git evidence without locks, then evaluate once on a fresh versioned snapshot. */
export class MergeShadowObserver {
  private readonly cache = new Map<string, MergeShadowPaths>();
  constructor(
    private readonly store: Store,
    private readonly git: MergeGit | undefined,
    private readonly clock: Clock,
  ) {}
  async tick(project: ProjectId): Promise<void> {
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const pref = projectPreferences(state);
    if (pref.system_merge_shadow !== true) return;
    const candidates = state.decisions.filter(
      (q) =>
        q.trigger === "merge_confirmation" &&
        q.card_id &&
        (["open", "provisional", "snoozed"].includes(q.status) ||
          !eventsForDecision(state.events, q.id).some(
            (e) => e.type === "system_merge_shadow_recorded",
          )),
    );
    const policy = pref.system_merge_shadow_policy;
    const pathsConfigured =
      validMergeShadowPolicy(policy) &&
      policy &&
      policy.role_rule_paths.length > 0 &&
      policy.release_paths.length > 0;
    const evidence = new Map<DecisionId, MergeShadowPaths | undefined>();
    const binding = candidates.length
      ? this.git?.projectOf(project)
      : undefined;
    let sampledBase: string | undefined;
    for (const q of candidates) {
      const card = state.cards.find((c) => c.id === q.card_id);
      if (!card) continue;
      let paths: MergeShadowPaths | undefined;
      if (
        pathsConfigured &&
        q.status === "open" &&
        q.kind === "approve" &&
        "delivery_id" in q.target &&
        binding &&
        card.base_branch === binding.base_branch &&
        this.git?.baseline &&
        this.git.changedPaths
      ) {
        try {
          sampledBase ??= await this.git.baseline(binding);
          const base = sampledBase;
          const versions = currentPreMergeVersions(
            card,
            state.work_items,
            state.deliveries,
          );
          const key = JSON.stringify([
            q.target.delivery_id,
            card.base_branch,
            base,
            versions,
          ]);
          paths = this.cache.get(`${project}:${q.id}`);
          if (
            !paths ||
            JSON.stringify([
              paths.completion_id,
              paths.base_branch,
              paths.base_sha,
              paths.versions.map(({ paths: _paths, ...v }) => v),
            ]) !== key
          ) {
            const changed = [];
            for (const v of versions)
              changed.push({
                ...v,
                paths: await this.git.changedPaths(binding, base, v.subject),
              });
            paths = {
              completion_id: q.target.delivery_id,
              base_branch: card.base_branch,
              base_sha: base,
              versions: changed,
            };
          }
          this.cache.set(`${project}:${q.id}`, paths);
        } catch {
          // No raw Git diagnostics in project events. Unknown paths are conservative.
          paths = undefined;
        }
      }
      evidence.set(q.id, paths);
    }
    // Recheck the sampled baseline after **all** Git IO. A move while reading a
    // later candidate also invalidates the earlier candidates' path evidence.
    if (sampledBase && binding) {
      let current: string | undefined;
      try {
        current = await this.git?.baseline?.(binding);
      } catch {
        /* unavailable evidence is uncertain */
      }
      if (current !== sampledBase)
        for (const id of evidence.keys()) evidence.set(id, undefined);
    }
    if (evidence.size)
      applyMaintenancePlan(this.store, project, (tx) => {
        const fresh = loadCommandState(tx, project);
        const writes: MaintenanceWrite[] = [];
        if (projectPreferences(fresh).system_merge_shadow !== true)
          return writes;
        for (const q of fresh.decisions) {
          if (!evidence.has(q.id)) continue;
          const paths = evidence.get(q.id);
          const emit = prepareMergeShadow(
            fresh,
            { kind: "system", project_id: project },
            { decision_id: q.id, ...(paths ? { paths } : {}) },
          );
          if (emit)
            writes.push((tx) =>
              persistEffect(
                tx,
                project,
                unwrap(emit({ clock: this.clock, ids: tx.ids })),
              ),
            );
        }
        return writes;
      });
    const active = new Set(candidates.map((q) => `${project}:${q.id}`));
    for (const key of this.cache.keys())
      if (key.startsWith(`${project}:`) && !active.has(key))
        this.cache.delete(key);
  }
}
