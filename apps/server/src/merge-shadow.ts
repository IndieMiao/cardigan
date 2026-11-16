import {
  type Clock,
  currentPreMergeVersions,
  type MergeShadowPaths,
  type ProjectId,
  projectPreferences,
  recordMergeShadow,
  validMergeShadowPolicy,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";

/** Read-only Git evidence outside the transaction, then re-evaluate fresh state inside it. */
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
          !state.events.some(
            (e) =>
              e.type === "system_merge_shadow_recorded" &&
              (e.payload as { decision_id?: string }).decision_id === q.id,
          )),
    );
    const policy = pref.system_merge_shadow_policy;
    const pathsConfigured =
      validMergeShadowPolicy(policy) &&
      policy &&
      policy.role_rule_paths.length > 0 &&
      policy.release_paths.length > 0;
    for (const q of candidates) {
      const card = state.cards.find((c) => c.id === q.card_id);
      if (!card) continue;
      let paths: MergeShadowPaths | undefined;
      const binding = this.git?.projectOf(project);
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
          const base = await this.git.baseline(binding);
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
          // If the baseline moved during IO, do not treat the sampled paths as current.
          if ((await this.git.baseline(binding)) !== base) paths = undefined;
          if (paths) this.cache.set(`${project}:${q.id}`, paths);
        } catch {
          // No raw Git diagnostics in project events. Unknown paths are conservative.
          paths = undefined;
        }
      }
      this.store.uow.run((tx) => {
        const fresh = loadCommandState(tx, project);
        // A concurrent deletion must not turn an observation into a dispatch failure.
        if (!fresh.decisions.some((d) => d.id === q.id)) return;
        const result = recordMergeShadow(
          fresh,
          { kind: "system", project_id: project },
          { decision_id: q.id, ...(paths ? { paths } : {}) },
          { clock: this.clock, ids: tx.ids },
        );
        if (!result.ok) throw new Error(result.error.message);
        persistEffect(tx, project, result.value);
      });
    }
    const active = new Set(candidates.map((q) => `${project}:${q.id}`));
    for (const key of this.cache.keys())
      if (key.startsWith(`${project}:`) && !active.has(key))
        this.cache.delete(key);
  }
}
