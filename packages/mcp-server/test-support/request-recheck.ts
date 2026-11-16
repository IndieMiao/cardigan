import type { Store } from "@cardigan/store";
import { returnedRecheckFixture } from "../../domain/src/commands/request-recheck/test-fixtures.js";
import { loadCommandState } from "../src/commands/execute.js";

/** Persist a synthetic flow-2 history, advancing the real transactional allocators. */
export async function seedReturnedRecheck(store: Store) {
  const original = await returnedRecheckFixture();
  const initial = original.f.state;
  const project = initial.project_id;
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const row of initial.machines ?? []) tx.machines.put(project, row);
    for (const row of initial.cards) tx.cards.put(project, row);
    for (const row of initial.work_items) tx.work_items.put(project, row);
    for (const row of initial.assignments) tx.assignments.put(project, row);
    for (const row of initial.runs) tx.runs.put(project, row);
    for (const row of initial.deliveries) tx.deliveries.put(project, row);
    for (const row of initial.reviews) tx.reviews.put(project, row);
    for (const row of initial.decisions) tx.decisions.put(project, row);
    for (const row of initial.roles) tx.roles.put(project, row);
    for (const row of initial.events) {
      tx.events.append(project, row);
      tx.ids.nextEventSequence(project, row.card_id);
    }
    for (const row of initial.timeline) tx.timeline.put(project, row);
    for (const [kind, rows] of [
      ["delivery", initial.deliveries],
      ["decision", initial.decisions],
      ["review", initial.reviews],
    ] as const) {
      const maximum = Math.max(
        0,
        ...rows.map((row) => Number(row.id.slice(2))),
      );
      for (let n = 0; n < maximum; n++) tx.ids.next(project, kind);
    }
    for (const card of initial.cards)
      for (
        let n = 0;
        n <
        Math.max(
          0,
          ...initial.timeline
            .filter((row) => row.card_id === card.id)
            .map((row) => Number(row.id.split("#")[1])),
        );
        n++
      )
        tx.ids.nextTimelineEntryId(project, card.id);
  });
  return {
    ...original,
    project,
    read: () => store.uow.read((tx) => loadCommandState(tx, project)),
  };
}
