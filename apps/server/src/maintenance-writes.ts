import type { ProjectId } from "@cardigan/domain";
import type {
  ReadRepositories,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";

export type MaintenanceWrite = (tx: StoreTransactionContext) => void;

/** Prepare from one consistent snapshot. Each short transaction checks its
 * predecessor's committed revision; a concurrent edit leaves the rest for next tick. */
export function applyMaintenancePlan(
  store: Store,
  project: ProjectId,
  prepare: (tx: ReadRepositories) => MaintenanceWrite[],
  includeInbox = false,
) {
  const revision = () => {
    const state = store.snapshotVersion(project);
    if (state === undefined)
      throw new Error("Maintenance requires a versioned snapshot");
    if (!includeInbox) return state;
    // The command snapshot intentionally excludes inbox-only mutations (e.g. ACK).
    const inbox =
      store
        .changesSince(project, ["notifications"], undefined)
        ?.cursor.versions.get("notifications") ?? 0;
    return `${state}/${inbox}`;
  };
  const { writes, version } = store.uow.read((tx) => ({
    version: revision(),
    writes: prepare(tx),
  }));
  let expected = version;
  const batchSize = 16;
  for (let start = 0; start < writes.length; start += batchSize) {
    const batch = writes.slice(start, start + batchSize);
    const next = store.uow.run((tx) => {
      if (revision() !== expected) return;
      for (const write of batch) write(tx);
      return revision();
    });
    if (next === undefined) return;
    expected = next;
  }
}
