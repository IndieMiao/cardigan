import { expect, test } from "vitest";
import {
  assign,
  createCard,
  createWorkItem,
  mergePlan,
  prepareDelivery,
  submitDelivery,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

test.each([
  [false, true],
  [true, true],
  [false, false],
  [true, false],
] as const)(
  "invariants 13, 14: known gaps skip unfinished work (required=%s, accepted Git product=%s)",
  async (required, git) => {
    const f = mergeFixture("auto");
    const followup = f.commit(
      createCard(
        f.state,
        human,
        {
          title: "Follow up",
          goal: "Finish gap",
          acceptance_criteria: ["Remaining work"],
          source: { kind: "quote", text: "Deferred" },
          repo: "fixture",
          base_branch: "main",
        },
        f.io,
      ),
    );
    const extra = f.commit(
      createWorkItem(
        f.state,
        human,
        {
          card_id: f.card.id,
          title: "Deferred code",
          kind: "produce",
          role_id: "coder",
          required,
          completion_criteria: ["Pass review"],
        },
        f.io,
      ),
    );
    const check = f.commit(
      createWorkItem(
        f.state,
        human,
        {
          card_id: f.card.id,
          title: "Deferred review",
          kind: "verify",
          role_id: "reviewer",
          required: true,
          target_work_item_id: extra.id,
          completion_criteria: ["Pass"],
        },
        f.io,
      ),
    );
    const owner = f.commit(
      assign(
        f.state,
        human,
        { work_item_id: extra.id, role_id: "coder" },
        f.io,
      ),
    );
    f.commit(
      assign(
        f.state,
        human,
        { work_item_id: check.id, role_id: "reviewer" },
        f.io,
      ),
    );
    if (!required) {
      f.start(owner);
      const p = {
        work_item_id: extra.id,
        kind: "code" as const,
        summary: "Unreviewed code",
        subject: { kind: "git_head" as const, value: "b".repeat(40) },
        requested_verifiers: [check.id],
      };
      const proof = value(
        await prepareDelivery(f.state, f.actor(owner), p, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      const unreviewed = f.commit(
        submitDelivery(f.state, f.actor(owner), p, proof, f.io),
      );
      expect(unreviewed.status).toBe("submitted");
    }
    const product = await f.deliver(git ? "code" : "doc", "a".repeat(40), git);
    f.review(product);
    const gaps = [check, ...(required ? [extra] : [])].map((w) => ({
      precondition: `work_item:${w.id}`,
      description: "Deferred to the follow-up card",
      followup_card_id: followup.id,
    }));
    const completion = await f.deliver(
      "card_completion",
      product.subject.value,
      git,
      gaps,
    );
    expect(completion.known_gaps).toEqual(gaps);
    f.review(completion);
    expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
      "accepted",
    );
    if (git) {
      const plan = value(mergePlan(f.state, f.card.id));
      expect(plan.deliveries).toEqual([
        {
          delivery_id: product.id,
          work_item_id: product.work_item_id,
          sha: product.subject.value,
        },
      ]);
      expect(plan.deliveries.some((v) => v.work_item_id === extra.id)).toBe(
        false,
      );
      expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
        "awaiting_merge",
      );
    } else {
      expect(f.state.cards.find((c) => c.id === f.card.id)).toMatchObject({
        status: "done",
        resolution: "done",
      });
      expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    }
  },
);
