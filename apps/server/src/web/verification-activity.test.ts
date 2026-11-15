import { submitReview, withdrawReview } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { mergeFixture } from "../../../../packages/domain/src/commands/merge/test-fixtures.js";
import { now } from "../../../../packages/domain/src/commands/test-fixtures.js";
import { readExecution } from "./execution-state.js";
import { cardDetail, executionView } from "./read.js";
import { scopedCardState } from "./sql-state.js";

test("scoped card and execution queries retain current target/Run facts and withdrawal waiting", async () => {
  const f = mergeFixture();
  const product = await f.deliver();
  f.start(f.reviewer);
  const store = Store.open({ dbPath: ":memory:" });
  const project = f.state.project_id;
  try {
    store.createProject({ id: project });
    const seed = () =>
      store.uow.run((tx) => {
        for (const v of f.state.cards) tx.cards.put(project, v);
        for (const v of f.state.work_items) tx.work_items.put(project, v);
        for (const v of f.state.assignments) tx.assignments.put(project, v);
        for (const v of f.state.runs) tx.runs.put(project, v);
        for (const v of f.state.deliveries) tx.deliveries.put(project, v);
        for (const v of f.state.reviews) tx.reviews.put(project, v);
        const existing = new Set(
          tx.events.listAfter(project, f.card.id, 0).map((e) => e.id),
        );
        for (const v of f.state.events)
          if (v.card_id === f.card.id && !existing.has(v.id))
            tx.events.append(project, v);
      });
    const read = () =>
      readExecution(store, project, new URL("http://fixture/execution"), now);
    seed();
    const view = read();
    expect(
      view.assignments.find((a) => a.id === f.reviewer.id)
        ?.verification_activity?.label,
    ).toBe("正在审核");
    expect(
      view.assignments.map((a) => [a.id, a.verification_activity]).sort(),
    ).toEqual(
      executionView(f.state, now)
        .assignments.map((a) => [a.id, a.verification_activity])
        .sort(),
    );
    store.uow.read((tx) => {
      const state = scopedCardState(store, tx, project, [f.card.id]);
      expect(
        cardDetail(state, f.card.id)?.work_items.find(
          (w) => w.id === f.reviewer.work_item_id,
        )?.verification_activity?.label,
      ).toBe("正在审核");
    });
    f.commit(
      submitReview(
        f.state,
        f.actor(f.reviewer),
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [],
          recheck_required: true,
        },
        f.io,
      ),
    );
    f.start(f.reviewer);
    seed();
    expect(
      read().assignments.find((a) => a.id === f.reviewer.id)
        ?.verification_activity?.label,
    ).toBe("正在审核");
    store.uow.read((tx) => {
      const scoped = scopedCardState(store, tx, project, [f.card.id]);
      expect(
        cardDetail(scoped, f.card.id)?.work_items.find(
          (w) => w.id === f.reviewer.work_item_id,
        )?.verification_activity?.label,
      ).toBe("正在审核");
    });
    const review = f.review(product);
    f.commit(
      withdrawReview(
        f.state,
        f.actor(f.reviewer),
        { work_item_id: review.work_item_id, rationale: "Rework" },
        f.io,
      ),
    );
    seed();
    expect(
      read().assignments.find((a) => a.id === f.reviewer.id)
        ?.verification_activity?.label,
    ).toBe("等待新交付");
  } finally {
    store.close();
  }
});
