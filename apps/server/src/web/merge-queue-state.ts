import type { CommandState, ProjectId } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { ReadRepositories } from "@cardigan/store";

/** Shared queue ordering needs peers outside the requested card/list page. */
export function readMergeQueueState(
  tx: ReadRepositories,
  project: ProjectId,
): CommandState | undefined {
  const config = tx.events
    .listAfter(project, undefined, 0)
    .findLast(
      (e) => e.actor.kind === "system" && e.type === "merge_queue_configured",
    );
  if (!config) return undefined;
  return loadCommandState(tx, project, {
    merge_gate_enabled: true,
    ...(config.payload
      ? {
          merge_queue: config.payload as unknown as NonNullable<
            NonNullable<CommandState["project_settings"]>["merge_queue"]
          >,
        }
      : {}),
  });
}
