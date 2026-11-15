import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveReviewMatrix,
  prepareDelivery,
  submitDelivery,
  submitReview,
  updateCard,
  withdrawReview,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  actor,
  fixture,
  human,
  id,
  now,
  subject,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";

test.each(["withdrawal", "qualification"] as const)(
  "reuse proof survives reopen, rollback and cross-connection %s",
  async (change) => {
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
        const invalidate = (rollback: boolean) =>
          other.uow.run((tx) => {
            const state = loadCommandState(tx, project);
            const io = { ids: tx.ids, clock: { now: () => now } };
            const effect =
              change === "withdrawal"
                ? value(
                    withdrawReview(
                      state,
                      actor(2, "reviewer"),
                      {
                        work_item_id: original.work_item_id,
                        rationale: "Recheck persisted evidence",
                      },
                      io,
                    ),
                  )
                : value(
                    updateCard(
                      state,
                      human,
                      {
                        card_id: id("card", 1),
                        acceptance_criteria: ["Changed requirement"],
                      },
                      io,
                    ),
                  );
            persistEffect(tx, project, effect);
            if (rollback) throw new Error("rollback");
          });
        expect(() => invalidate(true)).toThrow("rollback");
        expect(read().reviews).toEqual([original]);
        expect(read().deliveries).toEqual(before.deliveries);
        invalidate(false);
        const state = read();
        expect(state.reviews).toHaveLength(1);
        expect(state.reviews[0]).toMatchObject({
          id: original.id,
          delivery_id: first.id,
          ...(change === "withdrawal"
            ? { withdrawn: { rationale: "Recheck persisted evidence" } }
            : { reuse_invalidated_at: now }),
        });
        if (change === "qualification") {
          expect(state.deliveries.find((v) => v.id === second.id)?.status).toBe(
            "superseded",
          );
          expect(
            state.work_items.find((w) => w.id === params.work_item_id)?.status,
          ).toBe("changes_requested");
          expect(
            state.work_items.find((w) => w.id === id("work_item", 2))?.status,
          ).toBe("todo");
          expect(
            state.events.some((e) => e.type === "review_reuse_invalidated"),
          ).toBe(true);
        }
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
  },
);
