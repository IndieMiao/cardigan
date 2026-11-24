import {
  type Card,
  type CommandState,
  isProjectMergeEventType,
  type ProjectId,
  streamEventsBy,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { ReadRepositories } from "@cardigan/store";

/** Shared queue ordering needs peers outside the requested card/list page. */
export function readMergeQueueState(
  tx: ReadRepositories,
  project: ProjectId,
  detail?: { card: Card; state: CommandState },
): CommandState | undefined {
  if (detail && !["done", "awaiting_merge"].includes(detail.card.status))
    return undefined;
  const events =
    tx.projectMergeEvents?.(project) ??
    streamEventsBy(
      tx.events,
      project,
      undefined,
      "type",
      isProjectMergeEventType,
    );
  const config = events.findLast(
    (e) => e.actor.kind === "system" && e.type === "merge_queue_configured",
  );
  if (!config) return undefined;
  // A closed card can show its published batch but never has a queue position.
  if (detail?.card.status === "done")
    return { ...detail.state, events: [...detail.state.events, ...events] };
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
