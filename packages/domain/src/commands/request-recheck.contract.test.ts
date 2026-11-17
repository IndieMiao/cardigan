import { expect, test } from "vitest";
import {
  type Actor,
  autoConfirmMerge,
  type CommandState,
  deriveReviewMatrix,
  FLOW_VERSION_MAX,
  formMergeBatch,
  identifyMergeBatchCulprit,
  mergePlan,
  mergeQueue,
  mergeRequiresHuman,
  prepareMergePlan,
  prepareRecheck,
  ROLE_TOOL_ALLOWLISTS,
  recordDecision,
  recordMergeBatchCheck,
  recordMergeCheck,
  requestRecheck,
  requeueMergeBatch,
  resolveDelegatedDecision,
  setCardSensitive,
  setProjectPreferences,
  updateCard,
} from "../index.js";
import {
  recheckVerifier,
  returnedRecheckFixture,
} from "./request-recheck/test-fixtures.js";
import {
  actor,
  apply,
  assignment,
  human,
  id,
  now,
  value,
} from "./test-fixtures.js";

const params = { card_id: id("card", 101), reason: "合成的无关用例失败" };

test("A1d atomically redelivers and completes with original review provenance and a fresh plan", async () => {
  const { f, product, completion, fail } = await returnedRecheckFixture();
  const before = f.state;
  const receipt = value(
    await prepareRecheck(before, f.actor(f.coder), params, recheckVerifier()),
  );
  const effect = value(
    requestRecheck(before, f.actor(f.coder), params, receipt, f.io),
  );
  expect(before.cards[0]?.status).toBe("in_progress");
  const result = f.commit({ ok: true, value: effect });
  expect(result.product).toMatchObject({
    recheck_of: product.id,
    status: "accepted",
    reused_reviews: [before.reviews[0]?.id],
  });
  expect(result.completion).toMatchObject({
    recheck_of: completion.id,
    status: "accepted",
    reused_reviews: [before.reviews[1]?.id],
  });
  expect(f.state.reviews).toEqual(before.reviews);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(
    f.state.work_items.every((w) => ["accepted", "passed"].includes(w.status)),
  ).toBe(true);
  expect(
    deriveReviewMatrix(
      f.state.deliveries,
      f.state.work_items,
      f.state.reviews,
    ).filter((r) => r.delivery_id === result.completion.id)[0],
  ).toMatchObject({
    verdict: "pass",
    reused_from: { delivery_id: completion.id },
  });
  expect(value(prepareMergePlan(f.state, f.card.id))).toMatchObject({
    completion_id: result.completion.id,
    deliveries: [
      { delivery_id: result.product.id, sha: product.subject.value },
    ],
  });
  expect(
    effect.events.filter((e) => e.type === "recheck_requested"),
  ).toHaveLength(1);
  expect(effect.events.some((e) => e.type === "review_submitted")).toBe(false);
  // A repeat after another A1 return still consumes the same persistent SHA group.
  fail(result.completion);
  f.start(f.coder);
  expect(
    await prepareRecheck(f.state, f.actor(f.coder), params, recheckVerifier()),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("已使用") },
  });
  expect(FLOW_VERSION_MAX).toBe(5);
});

test.each(["head", "tree"] as const)(
  "changed %s refuses recheck before any effect",
  async (change) => {
    const { f } = await returnedRecheckFixture();
    expect(
      await prepareRecheck(
        f.state,
        f.actor(f.coder),
        params,
        recheckVerifier(
          change === "head" ? "d".repeat(40) : "a".repeat(40),
          change === "tree" ? "e".repeat(40) : undefined,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  },
);

test.each([
  "human_return",
  "reviewer_return",
  "wrong_rule",
  "conflict",
  "new_delivery",
  "changed_set",
  "old_flow",
  "released",
  "other_card",
  "other_project",
  "non_primary",
  "standing",
  "human",
] as const)("%s cannot request an A1d recheck", async (change) => {
  const { f, returned, product } = await returnedRecheckFixture();
  let state: CommandState = f.state;
  let caller: Actor = f.actor(f.coder);
  if (
    ["human_return", "reviewer_return", "wrong_rule", "conflict"].includes(
      change,
    )
  )
    state = {
      ...state,
      events: state.events.map((e) =>
        e.id !== returned.id
          ? e
          : {
              ...e,
              ...(change === "human_return" ? { actor: human } : {}),
              ...(change === "reviewer_return"
                ? { actor: f.actor(f.reviewer) }
                : {}),
              ...(change === "conflict" ? { type: "merge_conflicted" } : {}),
              ...(change === "wrong_rule"
                ? { payload: { ...(e.payload as object), rule: "other" } }
                : {}),
            },
      ),
    };
  if (change === "new_delivery")
    state = {
      ...state,
      events: [
        ...state.events,
        { ...returned, type: "delivery_submitted", seq: returned.seq + 10 },
      ],
    };
  if (change === "changed_set")
    state = {
      ...state,
      deliveries: state.deliveries.map((v) =>
        v.id === product.id
          ? { ...v, subject: { ...v.subject, value: "d".repeat(40) } }
          : v,
      ),
    };
  if (change === "old_flow")
    state = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, flow_version: 1 })),
    };
  if (change === "released")
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === f.coder.id ? { ...a, status: "released" } : a,
      ),
    };
  if (change === "other_card") caller = f.actor(f.reviewer);
  if (change === "other_project")
    caller = { ...caller, project_id: "other-project" };
  if (change === "non_primary")
    state = {
      ...state,
      work_items: state.work_items.map((w) =>
        w.id === f.coder.work_item_id ? { ...w, template_key: "secondary" } : w,
      ),
    };
  if (change === "standing")
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === f.coder.id
          ? (({ work_item_id: _work, ...rest }) => ({
              ...rest,
              scope: "standing" as const,
            }))(a)
          : a,
      ),
    };
  if (change === "human") caller = human;
  expect(
    (await prepareRecheck(state, caller, params, recheckVerifier())).ok,
  ).toBe(false);
});

test("settlement rechecks current delivery and quota after asynchronous preparation", async () => {
  const { f } = await returnedRecheckFixture();
  const actor = f.actor(f.coder);
  const proof = value(
    await prepareRecheck(f.state, actor, params, recheckVerifier()),
  );
  const first = value(requestRecheck(f.state, actor, params, proof, f.io));
  expect(
    requestRecheck(apply(f.state, first), actor, params, proof, f.io).ok,
  ).toBe(false);
  const changed = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, branch: "changed" } : a,
    ),
  };
  expect(requestRecheck(changed, actor, params, proof, f.io).ok).toBe(false);
});

test.each(["withdrawn", "invalidated", "requirements", "identity"] as const)(
  "%s product proof cannot fabricate an accepted recheck",
  async (change) => {
    const { f } = await returnedRecheckFixture();
    let s = f.state;
    if (change === "withdrawn")
      s = {
        ...s,
        reviews: s.reviews.map((r) => ({
          ...r,
          withdrawn: { at: now, rationale: "withdrawn" },
        })),
      };
    if (change === "invalidated")
      s = {
        ...s,
        reviews: s.reviews.map((r) => ({ ...r, reuse_invalidated_at: now })),
      };
    if (change === "requirements")
      s = apply(
        s,
        value(
          updateCard(s, human, { card_id: f.card.id, goal: "Changed" }, f.io),
        ),
      );
    if (change === "identity")
      s = {
        ...s,
        assignments: s.assignments.map((a) =>
          a.id === f.reviewer.id ? { ...a, employee_id: "E-999" as never } : a,
        ),
      };
    const proof = value(
      await prepareRecheck(s, f.actor(f.coder), params, recheckVerifier()),
    );
    expect(requestRecheck(s, f.actor(f.coder), params, proof, f.io).ok).toBe(
      false,
    );
  },
);

test("invalid completion pass stays ready for real verification; publication rechecks reused proof", async () => {
  const { f, completion } = await returnedRecheckFixture();
  const s = {
    ...f.state,
    reviews: f.state.reviews.map((r) =>
      r.delivery_id === completion.id ? { ...r, reuse_invalidated_at: now } : r,
    ),
  };
  const proof = value(
    await prepareRecheck(s, f.actor(f.coder), params, recheckVerifier()),
  );
  const e = value(requestRecheck(s, f.actor(f.coder), params, proof, f.io));
  expect(e.data.completion.status).toBe("submitted");
  expect(e.data.completion.reused_reviews).toBeUndefined();
  expect(
    apply(s, e).work_items.find((w) => w.id === f.pm.work_item_id)?.status,
  ).toBe("ready");
  const goodProof = value(
    await prepareRecheck(f.state, f.actor(f.coder), params, recheckVerifier()),
  );
  const good = value(
    requestRecheck(f.state, f.actor(f.coder), params, goodProof, f.io),
  );
  const current = apply(f.state, good);
  const invalid = {
    ...current,
    reviews: current.reviews.map((r) => ({ ...r, reuse_invalidated_at: now })),
  };
  expect(prepareMergePlan(invalid, f.card.id).ok).toBe(false);
  expect(mergePlan(invalid, f.card.id).ok).toBe(false);
});

test("producer-only role boundary excludes verification, standing and host operations", () => {
  expect(ROLE_TOOL_ALLOWLISTS.produce).toContain("request_recheck");
  expect(ROLE_TOOL_ALLOWLISTS.verify).not.toContain("request_recheck");
  expect(ROLE_TOOL_ALLOWLISTS.standing).not.toContain("request_recheck");
});

test("independent review and complete multi-product SHA group survive order changes; removal cannot split quota", async () => {
  const { f, completion, independent, secondary, fail } =
    await returnedRecheckFixture(undefined, {
      independent: true,
      secondary: true,
    });
  if (!independent || !secondary) throw new Error("Missing synthetic owners");
  const before = f.state;
  const reversed = { ...before, deliveries: [...before.deliveries].reverse() };
  const proof = value(
    await prepareRecheck(reversed, f.actor(f.coder), params, recheckVerifier()),
  );
  const next = f.commit(
    requestRecheck(reversed, f.actor(f.coder), params, proof, f.io),
  );
  expect(next.completion).toMatchObject({
    status: "accepted",
    recheck_of: completion.id,
  });
  const originalReview = before.reviews.find(
    (r) => r.work_item_id === independent.work_item_id,
  );
  expect(next.product.reused_reviews).toContain(originalReview?.id);
  const check = f.state.cards[0]?.pre_merge_checks?.find(
    (c) => c.label === "独立复核",
  );
  expect(check).toMatchObject({
    status: "passed",
    reused_from: originalReview?.id,
  });
  expect(f.state.reviews).toEqual(before.reviews);
  expect(value(prepareMergePlan(f.state, f.card.id)).deliveries).toHaveLength(
    2,
  );
  fail(next.completion);
  f.start(f.coder);
  const s = { ...f.state, deliveries: [...f.state.deliveries].reverse() };
  expect(
    (await prepareRecheck(s, f.actor(f.coder), params, recheckVerifier())).ok,
  ).toBe(false);
  const split = {
    ...s,
    deliveries: s.deliveries.filter(
      (v) => v.work_item_id !== secondary.work_item_id,
    ),
  };
  expect(
    (await prepareRecheck(split, f.actor(f.coder), params, recheckVerifier()))
      .ok,
  ).toBe(false);
});

test("A1d preserves forced human confirmation and original resolved authorization audit", async () => {
  const reason = "必须由人亲自核对权限取舍";
  const { work_item_id: _work, ...base } = assignment(999, "pm");
  const ops = {
    ...base,
    scope: "standing" as const,
    standing_mode: "ops" as const,
  };
  const { f } = await returnedRecheckFixture((f) => {
    f.commit({
      ok: true,
      value: {
        data: null,
        events: [],
        timeline: [],
        token_requests: [],
        changes: [{ collection: "assignments", entity: ops }],
      },
    });
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: 1 },
        f.io,
      ),
    );
    const q = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
    if (!q) throw new Error("Missing original confirmation");
    // Synthetic explicit handoff, followed by a real human authorization command.
    f.commit({
      ok: true,
      value: {
        data: null,
        events: [],
        timeline: [],
        token_requests: [],
        changes: [
          {
            collection: "decisions",
            entity: { ...q, decider: "human", human_required_reason: reason },
          },
        ],
      },
    });
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option: "merge",
          rationale: "人工批准",
          raw_quote: "同意合并",
        },
        f.io,
      ),
    );
  });
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  const old = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
  const proof = value(
    await prepareRecheck(f.state, f.actor(f.coder), params, recheckVerifier()),
  );
  f.commit(requestRecheck(f.state, f.actor(f.coder), params, proof, f.io));
  expect(f.state.decisions.find((q) => q.id === old?.id)).toEqual(old);
  const next = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation" && q.status === "open",
  );
  expect(next).toMatchObject({
    decider: "human",
    human_required_reason: reason,
    amends: old?.id,
  });
  if (!next) throw new Error("Missing new human confirmation");
  expect(mergeRequiresHuman(f.state, next)).toBeTruthy();
  const system = { kind: "system" as const, project_id: f.state.project_id };
  expect(
    autoConfirmMerge(
      f.state,
      system,
      { decision_id: next.id },
      { ...f.io, clock: { now: () => "2026-01-02T00:00:00.000Z" } },
    ).ok,
  ).toBe(false);
  expect(
    resolveDelegatedDecision(
      f.state,
      actor(999, "pm"),
      {
        decision_id: next.id,
        option: "merge",
        rationale: "不能代答",
        notice: "不能代答",
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
});

test("B3a: flow 5 recheck keeps product review provenance but regenerates completion instead of reusing PM acceptance", async () => {
  const { f, product, completion } = await returnedRecheckFixture((f) => {
    const current = f.state.cards.find((c) => c.id === f.card.id);
    if (!current) throw new Error("Missing card");
    f.commit({
      ok: true,
      value: {
        data: null,
        events: [],
        timeline: [],
        token_requests: [],
        changes: [
          { collection: "cards", entity: { ...current, flow_version: 5 } },
        ],
      },
    });
  });
  const receipt = value(
    await prepareRecheck(f.state, f.actor(f.coder), params, recheckVerifier()),
  );
  const result = f.commit(
    requestRecheck(f.state, f.actor(f.coder), params, receipt, f.io),
  );
  expect(result.product).toMatchObject({
    recheck_of: product.id,
    status: "accepted",
  });
  expect(result.completion).toMatchObject({
    recheck_of: completion.id,
    status: "submitted",
    system_completion: { products: [{ delivery_id: result.product.id }] },
  });
  expect(result.completion.reused_reviews).toBeUndefined();
  expect(
    f.state.timeline.find(
      (t) => t.delivery_id === result.completion.id && t.type === "delivery",
    )?.author,
  ).toBe("system");
});

test("A1d author recheck also follows a confirmed batch failure", async () => {
  const { f, completion } = await returnedRecheckFixture(undefined, {
    fail(f, completion) {
      const settings = {
        merge_gate_enabled: true,
        merge_queue: { max_batch_size: 4 },
      };
      const system: Actor = { kind: "system", project_id: f.state.project_id };
      const state = () => ({ ...f.state, project_settings: settings });
      const identity = {
        card_id: f.card.id,
        completion_id: completion.id,
        attempt_id: "card-pass",
        candidate_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
        base_sha: "d".repeat(40),
        level: "card" as const,
      };
      for (const status of ["queued", "running", "passed"] as const)
        f.commit(
          recordMergeCheck(
            state(),
            system,
            status === "passed"
              ? {
                  ...identity,
                  status,
                  checks: [{ name: "test", status: "passed", exit_code: 0 }],
                  summary: "Passed",
                  log_ref: "card-pass.log",
                }
              : { ...identity, status },
            f.io,
          ),
        );
      const q = f.state.decisions.find(
        (q) => q.trigger === "merge_confirmation" && q.card_id === f.card.id,
      )!;
      f.commit(
        recordDecision(
          state(),
          human,
          {
            decision_id: q.id,
            option: "merge",
            rationale: "Approved",
            raw_quote: "Merge",
          },
          f.io,
        ),
      );
      const batch = f.commit(
        formMergeBatch(
          state(),
          system,
          {
            base_sha: identity.base_sha,
            solo: false,
            members: [
              {
                card_id: f.card.id,
                completion_id: completion.id,
                merge_sha: identity.candidate_sha,
                tree_sha: identity.tree_sha,
              },
            ],
          },
          f.io,
        ),
      );
      for (const attempt of ["first", "confirmed"]) {
        if (attempt === "confirmed")
          f.commit(
            requeueMergeBatch(state(), system, { batch_id: batch.id }, f.io),
          );
        for (const status of ["queued", "running", "failed"] as const) {
          const check = {
            ...identity,
            level: "batch" as const,
            scope: { kind: "full" as const },
            attempt_id: attempt,
            status,
          };
          f.commit(
            recordMergeBatchCheck(
              state(),
              system,
              {
                batch_id: batch.id,
                completion_ids: [completion.id],
                check:
                  status === "failed"
                    ? {
                        ...check,
                        status,
                        checks: [
                          { name: "test", status: "failed", exit_code: 1 },
                        ],
                        summary: "SYNTHETIC_BATCH_SUMMARY",
                        log_ref: `${attempt}.log`,
                      }
                    : { ...check, status },
              },
              f.io,
            ),
          );
        }
      }
      f.commit(
        identifyMergeBatchCulprit(
          state(),
          system,
          { batch_id: batch.id, failed_batch_id: batch.id },
          f.io,
        ),
      );
      expect(
        f.state.events.findLast((e) => e.type === "merge_changes_requested")
          ?.payload,
      ).toMatchObject({ batch_id: batch.id });
      expect(
        JSON.stringify(
          f.state.events.findLast((e) => e.type === "merge_changes_requested"),
        ),
      ).not.toContain("SYNTHETIC_BATCH_SUMMARY");
      expect(mergeQueue(state())).toEqual([]);
    },
  });
  const input = {
    card_id: f.card.id,
    reason: "Unrelated infrastructure failure verified",
  };
  const proof = value(
    await prepareRecheck(f.state, f.actor(f.coder), input, recheckVerifier()),
  );
  const result = f.commit(
    requestRecheck(f.state, f.actor(f.coder), input, proof, f.io),
  );
  expect(result.completion.recheck_of).toBe(completion.id);
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "awaiting_merge",
  );
  expect(
    f.state.events.filter((e) => e.type === "recheck_requested"),
  ).toHaveLength(1);
});
