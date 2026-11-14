import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveReviewMatrix,
  prepareDelivery,
  submitDelivery,
  submitReview,
  withdrawReview,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  actor,
  fixture,
  id,
  now,
  subject,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";

test("reuse proof and its original review survive reopen, rollback and cross-connection withdrawal", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-review-reuse-"));
  let store = Store.open({ dataDir });
  const initial = fixture();
  const project = initial.project_id;
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  const params = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  try {
    store.createProject({ id: project });
    store.uow.run((tx) => {
      for (const card of initial.cards) tx.cards.put(project, card);
      for (const item of initial.work_items) tx.work_items.put(project, item);
      for (const assignment of initial.assignments)
        tx.assignments.put(project, assignment);
      for (const run of initial.runs) tx.runs.put(project, run);
      for (const role of initial.roles) tx.roles.put(project, role);
    });
    const deliver = async () => {
      const proof = value(
        await prepareDelivery(read(), actor(), params, {
          verify: async () => ({
            ok: true,
            value: [
              {
                kind: "commit",
                details: { sha: subject.value, tree_sha: "c".repeat(40) },
              },
            ],
          }),
        }),
      );
      return store.uow.run((tx) => {
        const effect = value(
          submitDelivery(
            loadCommandState(tx, project),
            actor(),
            params,
            proof,
            { ids: tx.ids, clock: { now: () => now } },
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      });
    };
    const first = await deliver();
    const original = store.uow.run((tx) => {
      const effect = value(
        submitReview(
          loadCommandState(tx, project),
          actor(2, "reviewer"),
          {
            delivery_id: first.id,
            target_sha: subject.value,
            kind: "code",
            issues: [],
          },
          { ids: tx.ids, clock: { now: () => now } },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.data;
    });
    const second = await deliver();
    expect(second.reused_reviews).toEqual([original.id]);
    const before = read();
    store.close();
    store = Store.open({ dataDir });
    expect(read().deliveries).toEqual(before.deliveries);
    expect(read().reviews).toEqual([original]);
    const other = Store.open({ dataDir });
    try {
      const withdraw = (rollback: boolean) =>
        other.uow.run((tx) => {
          const effect = value(
            withdrawReview(
              loadCommandState(tx, project),
              actor(2, "reviewer"),
              {
                work_item_id: original.work_item_id,
                rationale: "Recheck persisted evidence",
              },
              { ids: tx.ids, clock: { now: () => now } },
            ),
          );
          persistEffect(tx, project, effect);
          if (rollback) throw new Error("rollback");
        });
      expect(() => withdraw(true)).toThrow("rollback");
      expect(read().reviews).toEqual([original]);
      withdraw(false);
      const state = read();
      expect(state.reviews).toHaveLength(1);
      expect(state.reviews[0]).toMatchObject({
        id: original.id,
        delivery_id: first.id,
        withdrawn: { rationale: "Recheck persisted evidence" },
      });
      expect(
        deriveReviewMatrix(
          state.deliveries,
          state.work_items,
          state.reviews,
        ).find((r) => r.delivery_id === second.id)?.verdict,
      ).toBeNull();
    } finally {
      other.close();
    }
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
