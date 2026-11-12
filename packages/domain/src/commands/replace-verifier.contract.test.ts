import { expect, test } from "vitest";
import {
  type Actor,
  assign,
  type CommandState,
  type Delivery,
  developmentCardTemplate,
  finishRun,
  isCompletionVerifier,
  isReviewStale,
  prepareDelivery,
  releaseAssignment,
  replaceVerificationWorkItem,
  submitDelivery,
  submitReview,
  updateWorkItem,
  type WorkItem,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const params = (n = 3) => ({
  work_item_id: id("work_item", n),
  card_id: id("card", 1),
  template_key: n === 3 ? "pm_acceptance" : "code_review",
  reason: "原负责人已释放，换人继续验收",
});
function cancelled(): CommandState {
  const s = fixture();
  return {
    ...s,
    assignments: s.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" } : a,
    ),
    work_items: s.work_items.map((w) =>
      w.id === params().work_item_id ? { ...w, status: "cancelled" } : w,
    ),
  };
}
const ops = actor(4, "pm");

test("invariants 11, 15: cancelled verifier is replaced atomically without rebinding its identity", () => {
  const s = cancelled();
  const before = JSON.stringify(s);
  const result = value(replaceVerificationWorkItem(s, ops, params(), ports()));
  const next = result.data;
  expect(next).toMatchObject({
    card_id: params().card_id,
    kind: "verify",
    template_key: "pm_acceptance",
    role_id: "pm",
    required: true,
    status: "todo",
    completion_criteria: ["passes"],
    max_review_rounds: 3,
  });
  expect(next.assignment_id).toBeUndefined();
  expect(isCompletionVerifier(developmentCardTemplate, next)).toBe(true);
  const after = apply(s, result);
  expect(after.assignments).toEqual(s.assignments);
  expect(
    after.work_items.find((w) => w.id === params().work_item_id),
  ).toMatchObject({
    assignment_id: id("assignment", 3),
    template_key: "pm_acceptance",
    required: false,
    status: "cancelled",
    replaced_by_work_item_id: next.id,
  });
  expect(JSON.stringify(s)).toBe(before);
  expect(result.events).toMatchObject([
    {
      type: "work_item_replaced",
      actor: ops,
      payload: {
        work_item_id: params().work_item_id,
        replacement_work_item_id: next.id,
        reason: params().reason,
      },
    },
  ]);
  expect(replaceVerificationWorkItem(after, ops, params(), ports()).ok).toBe(
    false,
  );
  expect(
    updateWorkItem(
      after,
      ops,
      { work_item_id: params().work_item_id, required: true },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    assign(
      after,
      human,
      { work_item_id: params().work_item_id, role_id: "pm" },
      ports(),
    ).ok,
  ).toBe(false);
});

test.each([
  [
    "active",
    (s: CommandState) => ({ ...s, work_items: fixture().work_items }),
    params(),
  ],
  [
    "suspended",
    (s: CommandState) => ({
      ...s,
      work_items: fixture().work_items,
      assignments: s.assignments.map((a) =>
        a.id === id("assignment", 3)
          ? { ...a, status: "suspended" as const }
          : a,
      ),
    }),
    params(),
  ],
  [
    "produce",
    (s: CommandState) => s,
    { ...params(), work_item_id: id("work_item", 1) },
  ],
  [
    "cross card",
    (s: CommandState) => s,
    { ...params(), card_id: id("card", 2) },
  ],
  [
    "cross key",
    (s: CommandState) => s,
    { ...params(), template_key: "code_review" },
  ],
  [
    "no template",
    (s: CommandState) => ({
      ...s,
      work_items: s.work_items.map((w) => {
        const { template_key: _key, ...rest } = w;
        return rest;
      }),
    }),
    params(),
  ],
  [
    "missing",
    (s: CommandState) => s,
    { ...params(), work_item_id: id("work_item", 99) },
  ],
  ["empty reason", (s: CommandState) => s, { ...params(), reason: " " }],
  ...(["done", "cancelled", "awaiting_merge"] as const).map(
    (status) =>
      [
        status,
        (s: CommandState) => ({
          ...s,
          cards: s.cards.map((c) => ({ ...c, status })),
        }),
        params(),
      ] as const,
  ),
] as const)(
  "invariant 11: rejects %s with Chinese diagnostics and no partial effect",
  (_name, mutate, p) => {
    const s = mutate(cancelled());
    const before = JSON.stringify(s);
    const r = replaceVerificationWorkItem(s, ops, p, ports());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/[\u4e00-\u9fff]/u);
    expect(r).not.toHaveProperty("value");
    expect(JSON.stringify(s)).toBe(before);
  },
);

test.each(["office", "legacy", "work item", "coder", "reviewer", "host_ops"])(
  "invariant 11: rejects %s even with an overbroad historical tool grant",
  (kind) => {
    let s = cancelled();
    let caller: Actor = kind === "work item" ? actor(3, "pm") : ops;
    if (["office", "legacy"].includes(kind))
      s = {
        ...s,
        assignments: s.assignments.map((a) => {
          if (a.scope !== "standing") return a;
          const { standing_mode: _mode, ...rest } = a;
          return kind === "office"
            ? { ...rest, standing_mode: "office" }
            : rest;
        }),
      };
    if (["coder", "reviewer", "host_ops"].includes(kind)) {
      caller = actor(4, kind);
      s = {
        ...s,
        assignments: s.assignments.map((a) =>
          a.id === id("assignment", 4) ? { ...a, role_id: kind } : a,
        ),
        roles: [
          ...s.roles,
          {
            role_id: kind,
            role_version: 1,
            allowed_tools: ["replace_verification_work_item"],
            capabilities: [],
          },
        ],
      };
    }
    expect(replaceVerificationWorkItem(s, caller, params(), ports()).ok).toBe(
      false,
    );
  },
);

async function deliver(
  f: ReturnType<typeof mergeFixture>,
  kind: Delivery["kind"],
  verifiers: readonly WorkItem["id"][],
) {
  f.start(f.coder);
  const p = {
    work_item_id: f.coder.work_item_id as WorkItem["id"],
    kind,
    summary: "Ready",
    subject: { kind: "git_head" as const, value: "a".repeat(40) },
    requested_verifiers: verifiers,
  };
  const proof = value(
    await prepareDelivery(f.state, f.actor(f.coder), p, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return f.commit(submitDelivery(f.state, f.actor(f.coder), p, proof, f.io));
}

test.each(["pm", "reviewer"] as const)(
  "invariants 13–16: release → replace %s → fresh delivery and review → merge confirmation",
  async (role) => {
    const f = mergeFixture();
    const product = await f.deliver();
    const priorReview = f.review(product);
    const completion = await f.deliver("card_completion");
    const owner = role === "pm" ? f.pm : f.reviewer;
    const old = f.state.work_items.find((w) => w.id === owner.work_item_id);
    if (!old?.template_key) throw new Error("Missing verifier");
    for (const run of f.state.runs.filter(
      (r) => r.assignment_id === owner.id && r.status === "running",
    ))
      f.commit(
        finishRun(
          f.state,
          f.actor(owner),
          { run_id: run.id, outcome: "completed", summary: "Hand off" },
          f.io,
        ),
      );
    f.commit(
      releaseAssignment(f.state, human, { assignment_id: owner.id }, f.io),
    );
    // Invariant 15 stays intact before and after replacement.
    expect(
      assign(
        f.state,
        human,
        { work_item_id: old.id, role_id: old.role_id },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    const fresh = f.commit(
      replaceVerificationWorkItem(
        f.state,
        human,
        {
          work_item_id: old.id,
          card_id: old.card_id,
          template_key: old.template_key,
          reason: "换人",
        },
        f.io,
      ),
    );
    expect(fresh.target_work_item_id).toBe(old.target_work_item_id);
    expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
      "superseded",
    );
    expect(f.state.deliveries.find((v) => v.id === product.id)?.status).toBe(
      role === "pm" ? "accepted" : "superseded",
    );
    expect(
      f.state.deliveries.find((v) => v.id === completion.id)
        ?.requested_verifiers,
    ).toEqual(completion.requested_verifiers);
    const replacement = f.commit(
      assign(
        f.state,
        human,
        { work_item_id: fresh.id, role_id: old.role_id },
        f.io,
      ),
    );
    expect(replacement.id).not.toBe(owner.id);
    const nextProduct =
      role === "reviewer" ? await deliver(f, "code", [fresh.id]) : product;
    if (role === "reviewer") {
      expect(isReviewStale(priorReview, nextProduct)).toBe(true);
      f.start(replacement);
      f.commit(
        submitReview(
          f.state,
          f.actor(replacement),
          {
            delivery_id: nextProduct.id,
            target_sha: nextProduct.subject.value,
            kind: "code",
            issues: [],
          },
          f.io,
        ),
      );
    }
    const nextCompletion = await deliver(f, "card_completion", [
      role === "pm" ? fresh.id : (f.pm.work_item_id as WorkItem["id"]),
    ]);
    expect(nextCompletion.requested_verifiers).not.toContain(old.id);
    expect(JSON.stringify(nextCompletion.evidence)).not.toContain(
      `work_item:${old.id}`,
    );
    const acceptance = role === "pm" ? replacement : f.pm;
    f.start(acceptance);
    f.commit(
      submitReview(
        f.state,
        f.actor(acceptance),
        {
          delivery_id: nextCompletion.id,
          target_sha: nextCompletion.subject.value,
          kind: "product",
          issues: [],
        },
        f.io,
      ),
    );
    expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
      "awaiting_merge",
    );
    expect(f.state.decisions).toMatchObject([
      {
        trigger: "merge_confirmation",
        status: "open",
        target: { delivery_id: nextCompletion.id },
      },
    ]);
    expect(f.state.assignments.find((a) => a.id === owner.id)).toMatchObject({
      work_item_id: old.id,
      status: "released",
    });
  },
);

test("cancel alone never removes a required verifier or supplies a replacement", async () => {
  const s = cancelled();
  const p = {
    work_item_id: id("work_item", 1),
    kind: "card_completion" as const,
    summary: "Ready",
    subject: { kind: "git_head" as const, value: "a".repeat(40) },
    requested_verifiers: [],
  };
  expect(
    (
      await prepareDelivery(s, actor(), p, {
        verify: async () => ({ ok: true, value: [] }),
      })
    ).ok,
  ).toBe(false);
  expect(s.work_items.find((w) => w.id === id("work_item", 3))?.required).toBe(
    true,
  );
});

test("invariant 14: replacement invalidates preflight and a caller cannot request the retired verifier", async () => {
  const f = mergeFixture();
  f.start(f.coder);
  const old = f.state.work_items.find((w) => w.id === f.reviewer.work_item_id);
  if (!old?.template_key) throw new Error("Missing verifier");
  const p = {
    work_item_id: f.coder.work_item_id as WorkItem["id"],
    kind: "code" as const,
    summary: "Ready",
    subject: { kind: "git_head" as const, value: "a".repeat(40) },
    requested_verifiers: [old.id],
  };
  const verifier = { verify: async () => ({ ok: true as const, value: [] }) };
  const proof = value(
    await prepareDelivery(f.state, f.actor(f.coder), p, verifier),
  );
  f.commit(
    releaseAssignment(f.state, human, { assignment_id: f.reviewer.id }, f.io),
  );
  const replacement = f.commit(
    replaceVerificationWorkItem(
      f.state,
      human,
      {
        work_item_id: old.id,
        card_id: old.card_id,
        template_key: old.template_key,
        reason: "换人",
      },
      f.io,
    ),
  );
  const before = JSON.stringify(f.state);
  expect(submitDelivery(f.state, f.actor(f.coder), p, proof, f.io).ok).toBe(
    false,
  );
  expect(
    (
      await prepareDelivery(
        f.state,
        f.actor(f.coder),
        { ...p, requested_verifiers: [old.id, replacement.id] },
        verifier,
      )
    ).ok,
  ).toBe(false);
  expect(JSON.stringify(f.state)).toBe(before);
});

test("invariants 13, 14: replacement withdraws a pending human completion decision", async () => {
  const base = fixture();
  let s: CommandState = {
    ...base,
    card_templates: [
      {
        ...developmentCardTemplate,
        completion: { mode: "review", reviewer: "human" },
      },
    ],
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 3) ? { ...w, required: false } : w,
    ),
    runs: base.runs.filter((r) => r.assignment_id !== id("assignment", 3)),
  };
  const io = ports();
  const makeDelivery = async (kind: "code" | "card_completion") => {
    const p = {
      work_item_id: id("work_item", 1),
      kind,
      summary: "Ready",
      subject: { kind: "git_head" as const, value: "a".repeat(40) },
      requested_verifiers: kind === "code" ? [id("work_item", 2)] : [],
    };
    const proof = value(
      await prepareDelivery(s, actor(), p, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    const effect = value(submitDelivery(s, actor(), p, proof, io));
    s = apply(s, effect);
    return effect.data;
  };
  const product = await makeDelivery("code");
  s = apply(
    s,
    value(
      submitReview(
        s,
        actor(2, "reviewer"),
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    ),
  );
  const completion = await makeDelivery("card_completion");
  expect(s.decisions).toMatchObject([
    {
      trigger: "completion_review",
      status: "open",
      target: { delivery_id: completion.id },
    },
  ]);
  s = apply(
    s,
    value(
      finishRun(
        s,
        actor(2, "reviewer"),
        { run_id: id("run", 2), outcome: "completed", summary: "Hand off" },
        io,
      ),
    ),
  );
  s = apply(
    s,
    value(
      releaseAssignment(s, human, { assignment_id: id("assignment", 2) }, io),
    ),
  );
  s = apply(s, value(replaceVerificationWorkItem(s, human, params(2), io)));
  expect(s.decisions).toMatchObject([
    { trigger: "completion_review", status: "superseded" },
  ]);
  expect(s.deliveries.every((d) => d.status === "superseded")).toBe(true);
});
