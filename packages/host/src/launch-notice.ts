import type { Store, StoreTransactionContext } from "@cardigan/store";

/** Host configuration is shared: record the change on each installed project's stream. */
export function recordLaunchNotice(
  store: Store,
  tx: StoreTransactionContext,
  type: "launch_model_changed" | "launch_reload_failed",
  notice: string,
) {
  for (const project of store.listProjects()) {
    tx.events.append(project.id, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project.id),
      type,
      actor: { kind: "system", project_id: project.id },
      created_at: new Date().toISOString(),
      payload: { notice },
    });
  }
}
