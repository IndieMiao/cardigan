import {
  mergePlan,
  recordDecision,
  requestDeliveryRework,
  withdrawReview,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { mergeFixture } from "../../../packages/domain/src/commands/merge/test-fixtures.js";
import {
  human,
  now,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { mergePublicationGuard } from "./merge-publication.js";

test("an approved human rework fences a previously authorized publication at the actual CAS boundary", async () => {
  const f = mergeFixture();
  const { product } = await f.accept();
  const confirmation = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation",
  );
  const review = f.state.reviews.find((r) => r.delivery_id === product.id);
  if (!confirmation || !review) throw new Error("Missing fixture evidence");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: confirmation.id,
        option: "merge",
        rationale: "Approved",
        raw_quote: "Approved",
      },
      f.io,
    ),
  );
  const authorization = f.state.decisions.find(
    (q) => q.id === confirmation.id,
  )?.resolution;
  const oldPlan = value(mergePlan(f.state, f.card.id));
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      {
        work_item_id: review.work_item_id,
        rationale: "New approved requirement",
      },
      f.io,
    ),
  );
  const q = f.commit(
    requestDeliveryRework(
      f.state,
      human,
      {
        work_item_id: product.work_item_id,
        delivery_id: product.id,
        target_sha: product.subject.value,
        review_id: review.id,
        rationale: "Implement requirement",
      },
      f.io,
    ),
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "return_for_rework",
        rationale: "Return",
        raw_quote: "Return",
      },
      f.io,
    ),
  );
  expect(f.state.decisions.find((q) => q.id === confirmation.id)).toMatchObject(
    { status: "superseded", resolution: authorization },
  );
  const store = Store.open({ dbPath: ":memory:" });
  const project = f.state.project_id;
  try {
    store.createProject({ id: project });
    store.uow.run((tx) => {
      for (const v of f.state.cards) tx.cards.put(project, v);
      for (const v of f.state.work_items) tx.work_items.put(project, v);
      for (const v of f.state.assignments) tx.assignments.put(project, v);
      for (const v of f.state.runs) tx.runs.put(project, v);
      for (const v of f.state.deliveries) tx.deliveries.put(project, v);
      for (const v of f.state.reviews) tx.reviews.put(project, v);
      for (const v of f.state.decisions) tx.decisions.put(project, v);
      for (const v of f.state.events) tx.events.append(project, v);
    });
    let publications = 0;
    const guard = mergePublicationGuard({
      store,
      project,
      plan: oldPlan,
      result: {
        kind: "merged",
        previous_sha: "a".repeat(40),
        merge_sha: "b".repeat(40),
      },
      clock: { now: () => now },
    });
    expect(
      guard(() => {
        publications++;
      }),
    ).toBe(false);
    expect(publications).toBe(0);
    expect(
      store.uow.read((tx) =>
        tx.events
          .listAfter(project, f.card.id, 0)
          .some((e) => e.type === "card_merged"),
      ),
    ).toBe(false);
  } finally {
    store.close();
  }
});
