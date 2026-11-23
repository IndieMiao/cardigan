import {
  type CommandState,
  type Event,
  type ProjectId,
  telemetryEvents,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { orderedNeedsDecisions } from "./needs-order.js";

const snapshots = new WeakMap<
  Store,
  Map<ProjectId, { source: CommandState; value: CommandState }>
>();

/**
 * C-319: share the Store's committed, incremental snapshots with command readers.
 * Cache source data only: authorization and time-dependent views run on every read.
 */
export function readNeedsState(store: Store, project: ProjectId): CommandState {
  const source = store.uow.read((tx) => loadCommandState(tx, project));
  let projects = snapshots.get(store);
  if (!projects) {
    projects = new Map();
    snapshots.set(store, projects);
  }
  const previous = projects.get(project);
  if (previous?.source === source) return previous.value;
  // loadCommandState reassembles event streams on any collection revision.
  // Preserve immutable event indexes when every ordered event is still the
  // exact same object. Publish only after the Store read transaction committed.
  const events = previous?.value.events;
  const same = (a: readonly Event[], b: readonly Event[]) =>
    a.length === b.length && a.every((event, i) => event === b[i]);
  const value = {
    ...source,
    decisions: orderedNeedsDecisions(source),
    // C-643: the telemetry journal travels with the event array.
    events:
      events &&
      same(events, source.events) &&
      same(telemetryEvents(events), telemetryEvents(source.events))
        ? events
        : source.events,
  };
  projects.set(project, { source, value });
  return value;
}
