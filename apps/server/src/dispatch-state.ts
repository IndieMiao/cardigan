import type { CommandState, ProjectId } from "@cardigan/domain";
import {
  type CommandStateOptions,
  loadCommandState,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

export type StateLoader = (
  tx: Parameters<typeof loadCommandState>[0],
  project: ProjectId,
  project_settings?: CommandState["project_settings"],
  options?: CommandStateOptions,
) => CommandState;

/** One cache per tick, shared by routing, retry, maintenance and delivery. */
export function dispatchStateLoader(store: Store): StateLoader {
  const snapshots = new Map<
    ProjectId,
    { version: string; state: CommandState }
  >();
  return (tx, project, project_settings, options) => {
    // C-639: targeted loads may extend the hot history; the Store caches them.
    if (project_settings || options?.targets?.length)
      return loadCommandState(tx, project, project_settings, options);
    // Recheck inside every consuming transaction, including after awaits.
    // Relevant project/global writes (including other connections) refresh;
    // never reuse a pre-write snapshot for a claim, ACK or stop decision.
    const version = store.snapshotVersion(project);
    if (version === undefined) return loadCommandState(tx, project);
    const cached = snapshots.get(project);
    if (cached?.version === version) {
      if (
        cached.state.test_review_trust === tx.test_review_trust &&
        cached.state.read_machine_placement === tx.read_machine_placement
      )
        return cached.state;
      const {
        test_review_trust: _old,
        read_machine_placement: _reader,
        ...data
      } = cached.state;
      const state = {
        ...data,
        ...(tx.read_machine_placement
          ? { read_machine_placement: tx.read_machine_placement }
          : {}),
        ...(tx.test_review_trust
          ? { test_review_trust: tx.test_review_trust }
          : {}),
      };
      snapshots.set(project, { version, state });
      return state;
    }
    const state = loadCommandState(tx, project);
    snapshots.set(project, { version, state });
    return state;
  };
}
