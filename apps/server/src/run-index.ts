import type { Run } from "@cardigan/domain";

interface RunIndex {
  /** First Run per id, matching `runs.find((r) => r.id === id)`. */
  readonly byId: ReadonlyMap<string, Run>;
  /** First queued Run per Assignment, matching `runs.find(...queued)`. */
  readonly queued: ReadonlyMap<string, Run>;
}

/**
 * C-244: keyed Run lookups for the dispatcher. Run collections are immutable
 * snapshots (C-221 §6.3: Store snapshots, command drafts and fixtures all hand
 * out a new array on change), so an index keyed by the array's identity cannot
 * go stale, and a rolled-back snapshot keeps its own index. Weak keys free it.
 */
const indexes = new WeakMap<readonly Run[], RunIndex>();

function runIndex(runs: readonly Run[]): RunIndex {
  let index = indexes.get(runs);
  if (!index) {
    const byId = new Map<string, Run>();
    const queued = new Map<string, Run>();
    for (const r of runs) {
      if (!byId.has(r.id)) byId.set(r.id, r);
      if (r.status === "queued" && !queued.has(r.assignment_id))
        queued.set(r.assignment_id, r);
    }
    index = { byId, queued };
    indexes.set(runs, index);
  }
  return index;
}

export function runById(
  runs: readonly Run[],
  id: string | undefined,
): Run | undefined {
  return id === undefined ? undefined : runIndex(runs).byId.get(id);
}

export function queuedRun(
  runs: readonly Run[],
  assignment: string,
): Run | undefined {
  return runIndex(runs).queued.get(assignment);
}
