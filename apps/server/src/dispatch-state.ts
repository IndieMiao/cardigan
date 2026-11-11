import type { CommandState, ProjectId } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

export type StateLoader = (
  tx: Parameters<typeof loadCommandState>[0],
  project: ProjectId,
) => CommandState;

/** One cache per tick, shared by routing, retry, maintenance and delivery. */
export function dispatchStateLoader(store: Store): StateLoader {
  const snapshots = new Map<
    ProjectId,
    { version: string; state: CommandState }
  >();
  return (tx, project) => {
    // Recheck inside every consuming transaction, including after awaits.
    // Writes (also external commits or rollbacks) require an on-demand refresh;
    // never reuse a pre-write snapshot for a claim, ACK or stop decision.
    const version = store.snapshotVersion();
    const cached = snapshots.get(project);
    if (cached?.version === version) return cached.state;
    const state = loadCommandState(tx, project);
    snapshots.set(project, { version, state });
    return state;
  };
}
