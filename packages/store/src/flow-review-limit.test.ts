import type {
  CommandEffect,
  CommandState,
  Repository,
  TransactionContext,
} from "@cardigan/domain";
import { submitReview } from "@cardigan/domain";
import { expect, test } from "vitest";
import { flowReviewFixture } from "../../domain/src/commands/flow-review-limit/test-fixtures.js";
import { value } from "../../domain/src/commands/test-fixtures.js";
import type { ReadRepositories } from "./repositories.js";
import { Store } from "./store.js";
import { withTempStore } from "./test-support.js";

function persist(
  tx: TransactionContext,
  state: CommandState,
  effect: CommandEffect<unknown>,
) {
  for (const c of effect.changes)
    (tx[c.collection] as Pick<Repository<typeof c.entity, never>, "put">).put(
      state.project_id,
      c.entity,
    );
  for (const e of effect.events) tx.events.append(state.project_id, e);
  for (const t of effect.timeline) tx.timeline.put(state.project_id, t);
}

test.each([null, 1])(
  "B2 budget, waiting state and audit roll back together and survive competing replay/reopen (max=%s)",
  async (max) => {
    const { f } = flowReviewFixture(max);
    const target = await f.deliver();
    f.start(f.reviewer);
    withTempStore((store, dataDir) => {
      const project = f.state.project_id;
      store.createProject({ id: project });
      store.uow.run((tx) => {
        for (const m of f.state.machines ?? []) tx.machines.put(project, m);
        for (const r of f.state.roles) tx.roles.put(project, r);
        for (const c of f.state.cards) tx.cards.put(project, c);
        for (const w of f.state.work_items) tx.work_items.put(project, w);
        for (const a of f.state.assignments) tx.assignments.put(project, a);
        for (const r of f.state.runs) tx.runs.put(project, r);
        for (const v of f.state.deliveries) tx.deliveries.put(project, v);
        for (const p of f.state.project_preferences ?? [])
          tx.project_preferences.put(project, p);
      });
      const read = (tx: ReadRepositories): CommandState => ({
        ...f.state,
        cards: tx.cards.list(project),
        work_items: tx.work_items.list(project),
        assignments: tx.assignments.list(project),
        runs: tx.runs.list(project),
        deliveries: tx.deliveries.list(project),
        reviews: tx.reviews.list(project),
        decisions: tx.decisions.list(project),
        project_preferences: tx.project_preferences.list(project),
        events: tx.events.listAfter(project, f.card.id, 0),
        timeline: tx.timeline.list(project),
      });
      const review = (connection: Store, rollback = false) =>
        connection.uow.run((tx) => {
          const state = read(tx);
          const result = submitReview(
            state,
            f.actor(f.reviewer),
            {
              delivery_id: target.id,
              target_sha: target.subject.value,
              kind: "code",
              issues: [],
              recheck_required: true,
            },
            { ids: tx.ids, clock: f.io.clock },
          );
          if (result.ok) persist(tx, state, result.value);
          if (rollback) throw new Error("simulated commit failure");
          return result;
        });
      const before = store.uow.read(read);
      expect(() => review(store, true)).toThrow("simulated commit failure");
      expect(store.uow.read(read)).toEqual(before);
      let other = Store.open({ dataDir });
      try {
        value(review(store));
        // Competing writer must reload under its write transaction, not spend a stale budget.
        expect(review(other).ok).toBe(false);
        const after = other.uow.read(read);
        expect(after.decisions).toEqual([]);
        expect(after.reviews).toHaveLength(1);
        expect(
          after.work_items.find((w) => w.id === f.reviewer.work_item_id),
        ).toMatchObject(
          max
            ? { max_review_rounds: 2 }
            : { max_review_rounds: 1, status: "waiting_decision" },
        );
        expect(
          after.events.filter(
            (e) =>
              e.type ===
              (max
                ? "review_limit_raised_by_system"
                : "review_limit_auto_raise_exhausted"),
          ),
        ).toHaveLength(1);
        other.close();
        other = Store.open({ dataDir });
        expect(other.uow.read(read)).toEqual(after);
        expect(review(other).ok).toBe(false);
        expect(other.uow.read(read)).toEqual(after);
      } finally {
        other.close();
      }
    });
  },
);
