import { expect, test } from "vitest";
import type { WorkItemId } from "../ids.js";
import type { RequestDecisionParams } from "../index.js";
import {
  assign,
  createCard,
  issueInstruction,
  mergePlan,
  recordDecision,
  requestDecision,
  resolveReferences,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

/**
 * M5.T2 cross-acceptance for the human write path (plan phase-1-m5 §3.4, §3.5,
 * §3.6, M5.2). Oracles: the M5 plan and development plan §4.4, §4.5, §6.4, §8.2.
 *
 * Every state below starts from `createCard` + `assign`, so the assertions run
 * against the same transitions the Workbench reduces through `issueInstruction`
 * and `recordDecision`; nothing here writes a repository or hand-builds a card.
 */

/** The produce work item an Assignment owns; the fixture always assigns one. */
const ownedItem = (assignment: { readonly work_item_id?: WorkItemId }) =>
  assignment.work_item_id as WorkItemId;

const question: Omit<RequestDecisionParams, "card_id"> = {
  category: "general",
  kind: "choose",
  question: "要发布吗？",
  context: "需要你的方向",
  options: [{ key: "go", description: "继续", impact: "解锁实现" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
};

/** A second card with its own work items, created and assigned through the domain. */
function otherCard(f: ReturnType<typeof mergeFixture>) {
  const card = f.commit(
    createCard(
      f.state,
      human,
      {
        title: "Other",
        goal: "Ship something else",
        acceptance_criteria: ["Works"],
        source: { kind: "quote", text: "Build another" },
        repo: "fixture",
        base_branch: "main",
      },
      f.io,
    ),
  );
  const item = f.state.work_items.find(
    (w) => w.card_id === card.id && w.kind === "produce",
  );
  if (!item) throw new Error("The template has no produce work item");
  const owner = f.commit(
    assign(
      f.state,
      human,
      { work_item_id: item.id, role_id: item.role_id },
      f.io,
    ),
  );
  return { card, item, owner };
}

test("§3.5: a human instruction is one typed event and timeline entry, and changes no work or Run", () => {
  const f = mergeFixture();
  f.start(f.coder);
  const before = f.state,
    runs = before.runs.length,
    itemStatus = before.work_items.find((w) => w.id === ownedItem(f.coder))
      ?.status as string,
    cardStatus = before.cards.find((c) => c.id === f.card.id)?.status as string,
    body = `按 ${f.card.id} 的验收标准实现 ${ownedItem(f.coder)}，先看 q(9)`;
  const effect = value(
    issueInstruction(
      before,
      human,
      { card_id: f.card.id, work_item_id: ownedItem(f.coder), body },
      f.io,
    ),
  );
  expect(effect.events).toHaveLength(1);
  expect(effect.events[0]).toMatchObject({
    type: "instruction_issued",
    card_id: f.card.id,
    actor: { kind: "human", project_id: before.project_id },
    // §6.2: a bell carries IDs only; the body stays in the timeline.
    payload: { work_item_id: ownedItem(f.coder) },
  });
  expect(effect.timeline).toHaveLength(1);
  expect(effect.timeline[0]).toMatchObject({
    type: "instruction",
    author: "human",
    body,
    work_item_id: ownedItem(f.coder),
    retracted: false,
  });
  expect(effect.timeline[0]?.refs).toEqual(
    expect.arrayContaining([
      { kind: "card", id: f.card.id },
      { kind: "work_item", id: ownedItem(f.coder) },
      { kind: "decision", id: "Q-9" },
    ]),
  );
  // Invariant 10: an instruction is not a Run, and the command only appends.
  expect(effect.changes).toEqual([]);
  expect(effect.token_requests).toEqual([]);
  const next = apply(before, effect);
  expect(next.runs).toHaveLength(runs);
  expect(next.work_items.find((w) => w.id === ownedItem(f.coder))?.status).toBe(
    itemStatus,
  );
  expect(next.cursors).toEqual(before.cursors);
  // §3.4: the server resolves the same body against one project snapshot.
  expect(resolveReferences(next, body)).toEqual(
    expect.arrayContaining([
      {
        kind: "card",
        id: f.card.id,
        exists: true,
        status: cardStatus,
        card_id: f.card.id,
      },
      {
        kind: "work_item",
        id: ownedItem(f.coder),
        exists: true,
        status: itemStatus,
        card_id: f.card.id,
      },
      { kind: "decision", id: "Q-9", exists: false, status: null },
    ]),
  );
  // A second instruction is a second entry: the dispatcher, not the command,
  // decides whether the Assignment needs a new Run.
  const second = value(
    issueInstruction(
      next,
      human,
      {
        card_id: f.card.id,
        work_item_id: ownedItem(f.coder),
        body: "补充一条",
      },
      f.io,
    ),
  );
  expect(second.events).toHaveLength(1);
  expect(second.events[0]?.id).not.toBe(effect.events[0]?.id);
  expect(apply(next, second).runs).toHaveLength(runs);
});

test("§3.5/§9.2: an instruction needs the work item's own live card and refuses closed work", async () => {
  const f = mergeFixture(),
    other = otherCard(f),
    p = (work_item_id: string) => ({
      card_id: f.card.id,
      work_item_id: work_item_id as never,
      body: "Do it",
    }),
    rejected = (params = p(ownedItem(f.coder)), code = "illegal_transition") =>
      expect(issueInstruction(f.state, human, params, f.io)).toMatchObject({
        ok: false,
        error: { code },
      });
  // A work item of another card is not a valid instruction target.
  rejected(p(other.item.id), "validation_failed");
  // A delivered but unreviewed work item is still live work.
  const delivery = await f.deliver();
  expect(issueInstruction(f.state, human, p(ownedItem(f.coder)), f.io).ok).toBe(
    true,
  );
  // Once the verifier accepts it, the work item is finished.
  f.review(delivery);
  rejected();
  // The card must not be awaiting a merge either.
  const completion = await f.deliver("card_completion", delivery.subject.value);
  f.review(completion);
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "awaiting_merge",
  );
  rejected();
});

test("§4.4/§6.1: a human Needs You decision resumes the blocked work exactly once and keeps the quote", () => {
  const f = mergeFixture();
  f.start(f.coder);
  const q = f.commit(
    requestDecision(
      f.state,
      f.actor(f.coder),
      {
        ...question,
        card_id: f.card.id,
        blocking: true,
        affected_work_items: [ownedItem(f.coder)],
      },
      f.io,
    ),
  );
  expect(
    f.state.work_items.find((w) => w.id === ownedItem(f.coder))?.status,
  ).toBe("waiting_decision");
  const runs = f.state.runs.map((r) => r.id),
    resolution = f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option: "go",
          rationale: "继续",
          raw_quote: "我选 go",
        },
        f.io,
      ),
    );
  expect(resolution).toMatchObject({
    id: q.id,
    status: "resolved",
    resolution: {
      option: "go",
      resolved_by: "human",
      // §3.6: Workbench answers are always recorded as Needs You input.
      via: "needs_you",
      raw_quote: "我选 go",
    },
  });
  const event = f.state.events.findLast((e) => e.type === "decision_resolved");
  expect(event?.payload).toMatchObject({
    decision_id: q.id,
    option: "go",
    resume_work_items: [ownedItem(f.coder)],
  });
  const resumed = f.state.runs.filter((r) => !runs.includes(r.id));
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({
    assignment_id: f.coder.id,
    kind: "decision_resumed",
    status: "queued",
    trigger_event_id: event?.id,
  });
  expect(
    f.state.work_items.find((w) => w.id === ownedItem(f.coder))?.status,
  ).toBe("in_progress");
  // §5.2: the timeline keeps the human's words as the decision body.
  expect(
    f.state.timeline.findLast(
      (e) => e.decision_id === q.id && e.type === "decision_resolved",
    )?.body,
  ).toBe("我选 go");
  // Invariant 10/11: a replay cannot resolve twice or queue a second Run.
  expect(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "go",
        rationale: "继续",
        raw_quote: "我选 go",
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(f.state.runs).toHaveLength(runs.length + 1);
});

test("§3.6: the merge confirmation a human resolves is the decision `cardigan merge confirm` records", async () => {
  const f = mergeFixture(),
    { product } = await f.accept();
  const confirmation = f.state.decisions.find(
    (d) => d.trigger === "merge_confirmation",
  );
  if (!confirmation) throw new Error("No merge confirmation was requested");
  expect(confirmation).toMatchObject({
    status: "open",
    decider: "human",
    card_id: f.card.id,
  });
  // The merge stays blocked until the human confirms, whichever surface they use.
  expect(mergePlan(f.state, f.card.id)).toMatchObject({ ok: false });
  const resolved = f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: confirmation.id,
        option: "merge",
        rationale: "确认合并",
        raw_quote: "确认合并",
      },
      f.io,
    ),
  );
  expect(resolved.resolution).toMatchObject({
    option: "merge",
    via: "needs_you",
    resolved_by: "human",
  });
  expect(
    value(mergePlan(f.state, f.card.id)).deliveries.map((d) => d.delivery_id),
  ).toContain(product.id);
  // Exactly one confirmation exists: the web path reused the M4.4 decision.
  expect(
    f.state.decisions.filter((d) => d.trigger === "merge_confirmation"),
  ).toHaveLength(1);
});
