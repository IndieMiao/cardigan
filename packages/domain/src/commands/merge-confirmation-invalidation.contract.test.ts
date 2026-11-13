import { expect, test } from "vitest";
import {
  type Actor,
  type CommandEffect,
  type CommandState,
  type Decision,
  type Delivery,
  expireMergeSnoozes,
  listNeedsYou,
  prepareDelivery,
  recordDecision,
  recordMergeResult,
  submitDelivery,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const system: Actor = { kind: "system", project_id: human.project_id };
const conflict = (
  f: ReturnType<typeof mergeFixture>,
  product: Delivery,
  completion: Delivery,
) => ({
  card_id: f.card.id,
  completion_id: completion.id,
  result: {
    kind: "conflicted" as const,
    delivery_id: product.id,
    files: ["file.ts"],
  },
});

function expectClosed(
  state: CommandState,
  decision: Decision,
  completion: Delivery,
) {
  expect(state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(state.decisions.find((q) => q.id === decision.id)).toEqual({
    ...decision,
    status: "superseded",
  });
  expect(
    value(listNeedsYou(state, human)).data.decisions.some(
      (q) => q.id === decision.id,
    ),
  ).toBe(false);
  expect(
    state.events.filter(
      (e) =>
        e.type === "decision_superseded" &&
        (e.payload as { decision_id?: string }).decision_id === decision.id,
    ),
  ).toHaveLength(1);
  expect(state.timeline).toContainEqual(
    expect.objectContaining({
      type: "system",
      author: "system",
      decision_id: decision.id,
      delivery_id: completion.id,
      body: expect.stringContaining("自动标记为已被取代"),
    }),
  );
}

test("invariants 13, 14: a pre-confirmation conflict supersedes the pending decision and allows fresh completion", async () => {
  const f = mergeFixture();
  const { product, completion } = await f.accept();
  const decision = f.state.decisions[0];
  if (!decision) throw new Error("Missing confirmation");
  const state = { ...f.state, project_settings: { merge_gate_enabled: true } };
  const params = conflict(f, product, completion);
  const effect = value(recordMergeResult(state, system, params, f.io));
  // All changes and the explanation belong to the same atomic command effect.
  expect(effect.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        collection: "deliveries",
        entity: expect.objectContaining({
          id: completion.id,
          status: "superseded",
        }),
      }),
      expect.objectContaining({
        collection: "decisions",
        entity: expect.objectContaining({
          id: decision.id,
          status: "superseded",
        }),
      }),
    ]),
  );
  f.commit({ ok: true, value: effect });
  expectClosed(f.state, decision, completion);
  expect(value(recordMergeResult(f.state, system, params, f.io))).toMatchObject(
    { changes: [], events: [], timeline: [] },
  );
  expect(
    recordDecision(
      f.state,
      human,
      {
        decision_id: decision.id,
        option: "merge",
        rationale: "Late",
        raw_quote: "Merge",
      },
      f.io,
    ).ok,
  ).toBe(false);

  const next = await f.deliver("code", "b".repeat(40));
  f.review(next);
  const request = await f.deliver("card_completion", next.subject.value);
  f.review(request);
  expect(value(listNeedsYou(f.state, human)).data.decisions).toMatchObject([
    { status: "open", target: { delivery_id: request.id } },
  ]);
});

test("invariant 14: returning a merge closes every other open confirmation without replacing the human answer", async () => {
  const f = mergeFixture();
  const { completion } = await f.accept();
  const old = f.state.decisions[0];
  if (!old) throw new Error("Missing confirmation");
  // A persisted snapshot may contain multiple confirmations of one version.
  const id = f.io.ids.next(f.state.project_id, "decision");
  const latest: Decision = { ...old, id, key: id };
  const state = { ...f.state, decisions: [old, latest] };
  const effect = value(
    recordDecision(
      state,
      human,
      {
        decision_id: latest.id,
        option: "request_changes",
        rationale: "Fix input",
        raw_quote: "Fix input",
      },
      f.io,
    ),
  );
  const next = apply(state, effect);
  expectClosed(next, old, completion);
  expect(next.decisions.find((q) => q.id === latest.id)).toMatchObject({
    status: "resolved",
    resolution: { option: "request_changes", raw_quote: "Fix input" },
  });
  expect(value(listNeedsYou(next, human)).data.decisions).toEqual([]);
});

test.each(["card_completion", "code"] as const)(
  "invariant 14: a new %s invalidates pending confirmation before checking completion prerequisites",
  async (kind) => {
    const f = mergeFixture();
    const { product, completion } = await f.accept();
    const decision = f.state.decisions[0];
    if (!decision) throw new Error("Missing confirmation");
    f.start(f.coder);
    // Historical snapshots can have returned to execution with an open confirmation.
    // Delivering directly while awaiting_merge remains forbidden.
    const state: CommandState = {
      ...f.state,
      cards: [{ ...f.card, status: "review" }],
    };
    const params = {
      work_item_id: product.work_item_id,
      kind,
      ...(kind === "card_completion"
        ? { plain_summary: TEST_PLAIN_SUMMARY }
        : {}),
      summary: "Replacement",
      subject: product.subject,
      requested_verifiers:
        kind === "card_completion"
          ? completion.requested_verifiers
          : product.requested_verifiers,
    };
    const proof = value(
      await prepareDelivery(state, f.actor(f.coder), params, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    const effect = value(
      submitDelivery(state, f.actor(f.coder), params, proof, f.io),
    );
    expectClosed(apply(state, effect), decision, completion);
    f.commit({ ok: true, value: effect });
    f.review(effect.data);
    const request =
      kind === "card_completion"
        ? effect.data
        : await f.deliver("card_completion", product.subject.value);
    if (kind !== "card_completion") f.review(request);
    expect(value(listNeedsYou(f.state, human)).data.decisions).toMatchObject([
      { status: "open", target: { delivery_id: request.id } },
    ]);
  },
);

test("invariants 11, 14: unrelated blockers still reject a replacement without partial invalidation", async () => {
  const f = mergeFixture();
  const { product, completion } = await f.accept();
  const decision = f.state.decisions[0];
  if (!decision) throw new Error("Missing confirmation");
  f.start(f.coder);
  const id = f.io.ids.next(f.state.project_id, "decision");
  const state: CommandState = {
    ...f.state,
    cards: [{ ...f.card, status: "review" }],
    decisions: [
      decision,
      { ...decision, id, key: id, trigger: "completion_review" },
    ],
  };
  const before = JSON.stringify(state);
  const params = {
    work_item_id: product.work_item_id,
    kind: "card_completion" as const,
    plain_summary: TEST_PLAIN_SUMMARY,
    summary: "Replacement",
    subject: product.subject,
    requested_verifiers: completion.requested_verifiers,
  };
  const proof = value(
    await prepareDelivery(state, f.actor(f.coder), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  expect(
    submitDelivery(state, f.actor(f.coder), params, proof, f.io),
  ).toMatchObject({
    ok: false,
    error: {
      code: "invariant_violation",
      message: expect.stringContaining(`decision:${id}`),
    },
  });
  expect(JSON.stringify(state)).toBe(before);
});

test.each(["merge", "hold", "request_changes"])(
  "invariant 14: invalidation preserves resolved %s answers and unrelated open decisions",
  async (option) => {
    const f = mergeFixture();
    const { product, completion } = await f.accept();
    const decision = f.state.decisions[0];
    if (decision?.kind !== "approve") throw new Error("Missing confirmation");
    const copy = (changes: Partial<Decision>): Decision => {
      const id = f.io.ids.next(f.state.project_id, "decision");
      return {
        ...decision,
        id,
        key: id,
        blocking: false,
        ...changes,
      } as Decision;
    };
    const untouched = [
      copy({
        status: "resolved",
        resolution: {
          option,
          rationale: "Earlier choice",
          resolved_by: "human",
          via: "needs_you",
          raw_quote: option,
          via_chain: ["human"],
          at: f.io.clock.now(),
        },
      }),
      copy({ target: { delivery_id: product.id } }),
      copy({ target: { subject: product.subject } }),
      copy({ trigger: "completion_review" }),
      copy({ kind: "choose" }),
    ];
    const state = {
      ...f.state,
      project_settings: { merge_gate_enabled: true },
      decisions: [decision, ...untouched],
    };
    const effect: CommandEffect<unknown> = value(
      recordMergeResult(state, system, conflict(f, product, completion), f.io),
    );
    const next = apply(state, effect);
    expectClosed(next, decision, completion);
    for (const q of untouched)
      expect(next.decisions.find((entry) => entry.id === q.id)).toEqual(q);
  },
);

test("C-180: a merge conflict invalidates a snoozed confirmation atomically and expiry cannot revive it", async () => {
  const f = mergeFixture();
  const { product, completion } = await f.accept();
  const q = f.state.decisions[0];
  if (!q) throw new Error("Missing confirmation");
  const held = f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "hold",
        rationale: "等待",
        raw_quote: "等待",
      },
      f.io,
    ),
  );
  f.commit(
    recordMergeResult(
      { ...f.state, project_settings: { merge_gate_enabled: true } },
      system,
      conflict(f, product, completion),
      f.io,
    ),
  );
  expectClosed(f.state, held, completion);
  if (!held.snooze) throw new Error("Missing snooze");
  const until = held.snooze.until;
  expect(
    f.commit(
      expireMergeSnoozes(f.state, system, {
        ...f.io,
        clock: { now: () => until },
      }),
    ),
  ).toEqual([]);
  expect(f.state.decisions.find((v) => v.id === q.id)?.status).toBe(
    "superseded",
  );
});
