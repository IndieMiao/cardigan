import type {
  Clock,
  CommandState,
  GitPublicationGuard,
  MergePlan,
  MergeResult,
  ProjectId,
} from "@cardigan/domain";
import { mergePlan, recordMergeResult } from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/** Final authorization, ref CAS and audit share a synchronous SQLite write lock. */
export function mergePublicationGuard(input: {
  store: Store;
  project: ProjectId;
  plan: MergePlan;
  result: MergeResult;
  clock: Clock;
  settings?: CommandState["project_settings"];
  stopped?: () => boolean;
}): GitPublicationGuard {
  return (publish) =>
    input.store.uow.run((tx) => {
      const state = loadCommandState(tx, input.project, input.settings);
      const plan = mergePlan(state, input.plan.card_id);
      if (
        input.stopped?.() ||
        !plan.ok ||
        JSON.stringify(plan.value) !== JSON.stringify(input.plan)
      )
        return false;
      // Validate before touching Git; persist before yielding the write lock to
      // preferences, decisions or reviews, including writers in other processes.
      const result = recordMergeResult(
        state,
        { kind: "system", project_id: input.project },
        {
          card_id: input.plan.card_id,
          completion_id: input.plan.completion_id,
          result: input.result,
        },
        { ids: tx.ids, clock: input.clock },
      );
      if (!result.ok) return false;
      publish();
      persistEffect(tx, input.project, result.value);
      return true;
    });
}
