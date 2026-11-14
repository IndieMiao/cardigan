import type { Run } from "./entities.js";

interface RunIndex {
  /** First Run per id, matching `runs.find((r) => r.id === id)`. */
  readonly byId: ReadonlyMap<string, Run>;
  /** First queued Run per Assignment, matching `runs.find(...queued)`. */
  readonly queued: ReadonlyMap<string, Run>;
  /** Runs per Assignment, in array order. */
  readonly owned: ReadonlyMap<string, readonly Run[]>;
}

/**
 * C-244: keyed Run lookups for the dispatcher and its maintenance checks. Run collections are immutable
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
    const owned = new Map<string, Run[]>();
    for (const r of runs) {
      const list = owned.get(r.assignment_id);
      if (list) list.push(r);
      else owned.set(r.assignment_id, [r]);
      if (!byId.has(r.id)) byId.set(r.id, r);
      if (r.status === "queued" && !queued.has(r.assignment_id))
        queued.set(r.assignment_id, r);
    }
    index = { byId, queued, owned };
    indexes.set(runs, index);
  }
  return index;
}

/** Same result as `runs.find((r) => r.id === id)` for any `id` value. */
export function runById(runs: readonly Run[], id: unknown): Run | undefined {
  return typeof id === "string" ? runIndex(runs).byId.get(id) : undefined;
}

/** Same result as `runs.find((r) => r.assignment_id === a && r.status === "queued")`. */
export function queuedRun(
  runs: readonly Run[],
  assignment: string,
): Run | undefined {
  return runIndex(runs).queued.get(assignment);
}

/** Same members and order as `runs.filter((r) => r.assignment_id === id)`. */
export function runsOf(
  runs: readonly Run[],
  assignment: string,
): readonly Run[] {
  return runIndex(runs).owned.get(assignment) ?? [];
}
