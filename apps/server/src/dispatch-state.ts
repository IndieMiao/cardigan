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
    // Relevant project/global writes (including other connections) refresh;
    // never reuse a pre-write snapshot for a claim, ACK or stop decision.
    const version = store.snapshotVersion(project);
    if (version === undefined) return loadCommandState(tx, project);
    const cached = snapshots.get(project);
    if (cached?.version === version) return cached.state;
    const state = loadCommandState(tx, project);
    snapshots.set(project, { version, state });
    return state;
  };
}
