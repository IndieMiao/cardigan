import type { ContextObservation, ProjectId } from "@cardigan/domain";
import type { Store } from "./store.js";

/** Publish one completed project sample atomically, including an empty sample. */
export function writeContextSamples(
  store: Store,
  project: ProjectId,
  samples: readonly ContextObservation[],
): void {
  store.uow.run(() => {
    store.database
      .prepare(
        "INSERT INTO context_samples (project_id, doc) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET doc = excluded.doc",
      )
      .run(project, JSON.stringify(samples));
  });
}

/** Read only; consumers still apply the existing freshness/generation rules. */
export function readContextSamples(
  store: Store,
  project: ProjectId,
): readonly ContextObservation[] {
  return store.uow.read(() => {
    const row = store.database
      .prepare("SELECT doc FROM context_samples WHERE project_id = ?")
      .get(project);
    return row ? (JSON.parse(String(row.doc)) as ContextObservation[]) : [];
  });
}
