import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  assign,
  autoConfirmMerge,
  autoMergeSchedule,
  type CommandState,
  createWorkItem,
  type DecisionCategory,
  mergePlan,
  pmMergeBlockers,
  prepareDelivery,
  type RiskTag,
  recordDecision,
  recordMergeCheck,
  requestDecision,
  resolveDelegatedDecision,
  setCardSensitive,
  setProjectPreferences,
  standingTools,
  submitDelivery,
  submitReview,
  updateCard,
  updateWorkItem,
  type WorkItem,
  withdrawReview,
} from "../index.js";
import { CommandDraft } from "./core.js";
import { assignDecision, riskTagAutoMergeAllowed } from "./delegation.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const system: Actor = { kind: "system", project_id: human.project_id };

async function setup(
  tags: readonly RiskTag[] = ["permission"],
  independent = true,
  multiple = false,
  decidedCategory?: "credential" | "account" | "scope_change" | "permission",
) {
  const seed = fixture();
  const f = mergeFixture("confirm", 3, {
    state: {
      ...seed,
      cards: [],
      work_items: [],
      runs: [],
      assignments: [ops],
      roles: [...seed.roles, role("independent_reviewer")],
    },
    ports: ports(),
  });
  if (!f.coder.work_item_id) throw new Error("Missing producer");
  const item = independent
    ? f.commit(
        createWorkItem(
          f.state,
          human,
          {
            card_id: f.card.id,
            title: "Independent review",
            kind: "verify",
            role_id: "independent_reviewer",
            required: true,
            target_work_item_id: f.coder.work_item_id,
            completion_criteria: ["Safe"],
          },
          f.io,
        ),
      )
    : undefined;
  const owner = item
    ? f.commit(
        assign(
          f.state,
          human,
          {
            work_item_id: item.id,
            role_id: item.role_id,
          },
          f.io,
        ),
      )
    : undefined;
  if (decidedCategory) {
    const q = f.commit(
      requestDecision(
        f.state,
        human,
        {
          card_id: f.card.id,
          category: decidedCategory,
          kind: "choose",
          question: "批准此改动？",
          context: "范围与权限方案",
          options: [{ key: "yes", description: "批准", impact: "按方案实施" }],
          recommended: "yes",
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
          affected_cards: [f.card.id],
          affected_work_items: [],
          blocking: false,
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
          option: "yes",
          rationale: "批准",
          raw_quote: "同意",
        },
        { ...f.io, human_confirmation: "workbench" },
      ),
    );
  }
  const product = await f.deliver();
  f.review(product);
  if (owner) {
    f.start(owner);
    f.commit(
      submitReview(
        f.state,
        f.actor(owner),
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ),
    );
  }
  const extra = multiple ? await addProducer(f) : undefined;
  const tag = (risk_tags: readonly RiskTag[]) =>
    f.commit(
      updateCard(
        f.state,
        human,
        {
          card_id: f.card.id,
          risk_tags,
          high_risk: risk_tags.length > 0,
        },
        f.io,
      ),
    );
  tag(tags);
  const completion = await f.deliver("card_completion");
  f.review(completion);
  const confirmation = () => {
    const q = f.state.decisions.findLast(
      (q) => q.trigger === "merge_confirmation",
    );
    if (!q) throw new Error("Missing confirmation");
    return q;
  };
  const check = (status: "passed" | "failed") => {
    const identity = {
      card_id: f.card.id,
      completion_id: completion.id,
      attempt_id: `attempt-${status}`,
      candidate_sha: "b".repeat(40),
      tree_sha: (status === "passed" ? "c" : "d").repeat(40),
    };
    for (const step of ["queued", "running", status] as const)
      f.commit(
        recordMergeCheck(
          { ...f.state, project_settings: { merge_gate_enabled: true } },
          system,
          step === "queued" || step === "running"
            ? { ...identity, status: step }
            : {
                ...identity,
                status: step,
                summary: status,
                log_ref: `${identity.attempt_id}.log`,
                checks: [
                  {
                    name: "test",
                    status,
                    exit_code: status === "passed" ? 0 : 1,
                    duration_ms: 1,
                  },
                ],
              },
          f.io,
        ),
      );
  };
  const resolve = (
    state = f.state,
    notice: string | undefined = "复核和检查已通过。",
  ) =>
    resolveDelegatedDecision(
      state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "验证完成",
        ...(notice === undefined ? {} : { notice }),
      },
      f.io,
    );
  return {
    f,
    item,
    owner,
    product,
    extra,
    completion,
    tag,
    confirmation,
    check,
    resolve,
  };
}

async function addProducer(f: ReturnType<typeof mergeFixture>) {
  const producer = f.commit(
    createWorkItem(
      f.state,
      human,
      {
        card_id: f.card.id,
        title: "Second product",
        kind: "produce",
        role_id: "coder",
        required: true,
        completion_criteria: ["Works"],
      },
      f.io,
    ),
  );
  const item = f.commit(
    createWorkItem(
      f.state,
      human,
      {
        card_id: f.card.id,
        title: "Second independent review",
        kind: "verify",
        role_id: "independent_reviewer",
        required: true,
        target_work_item_id: producer.id,
        completion_criteria: ["Safe"],
      },
      f.io,
    ),
  );
  const owners = [producer, item].map((w) =>
    f.commit(
      assign(f.state, human, { work_item_id: w.id, role_id: w.role_id }, f.io),
    ),
  );
  const coder = owners[0];
  const owner = owners[1];
  if (!coder || !owner) throw new Error("Missing second product owners");
  f.start(coder);
  const input = {
    work_item_id: producer.id,
    kind: "code" as const,
    summary: "Second product ready",
    subject: { kind: "git_head" as const, value: "e".repeat(40) },
    requested_verifiers: [item.id],
  };
  const proof = value(
    await prepareDelivery(f.state, f.actor(coder), input, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const product = f.commit(
    submitDelivery(f.state, f.actor(coder), input, proof, f.io),
  );
  f.start(owner);
  f.commit(
    submitReview(
      f.state,
      f.actor(owner),
      {
        delivery_id: product.id,
        target_sha: product.subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  return { producer, item, owner, product };
}

test("each current product needs its own independent pass before PM confirmation", async () => {
  const { f, extra, confirmation, check, resolve } = await setup(
    undefined,
    true,
    true,
  );
  if (!extra) throw new Error("Missing second product");
  check("passed");
  expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(true);
  expect(confirmation().decider).toBe("role:pm");
  expect(pmMergeBlockers(f.state, confirmation())).toEqual([]);
  f.commit(resolve());
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test.each([
  "missing delivery",
  "completion only",
  "superseded delivery",
  "optional uncovered product",
  "two verifiers for one product",
  "cancelled product",
  "other card product",
  "no live products",
])("multi-product coverage handles %s", async (boundary) => {
  const { f, extra, product, confirmation } = await setup(
    undefined,
    true,
    true,
  );
  if (!extra) throw new Error("Missing second product");
  const state: CommandState = {
    ...f.state,
    deliveries: f.state.deliveries
      .filter(
        (v) => boundary !== "missing delivery" || v.id !== extra.product.id,
      )
      .map((v) =>
        v.id !== extra.product.id
          ? v
          : boundary === "completion only"
            ? { ...v, kind: "card_completion" }
            : boundary === "superseded delivery"
              ? { ...v, status: "superseded" }
              : v,
      ),
    reviews: f.state.reviews.filter(
      (r) =>
        boundary !== "optional uncovered product" ||
        r.work_item_id !== extra.item.id,
    ),
    work_items: f.state.work_items.map((w) => {
      if (boundary === "no live products" && w.kind === "produce")
        return { ...w, status: "cancelled" };
      if (
        boundary === "two verifiers for one product" &&
        w.id === extra.item.id &&
        w.kind === "verify"
      )
        return { ...w, target_work_item_id: product.work_item_id };
      if (w.id !== extra.producer.id) return w;
      if (boundary === "cancelled product")
        return { ...w, status: "cancelled" };
      if (boundary === "other card product")
        return { ...w, card_id: id("card", 999) };
      if (boundary === "optional uncovered product")
        return { ...w, required: false };
      return w;
    }),
  };
  const allowed = ["cancelled product", "other card product"].includes(
    boundary,
  );
  expect(riskTagAutoMergeAllowed(state, confirmation())).toBe(allowed);
  expect(
    assignDecision(
      new CommandDraft(state, human, "request_merge", f.io),
      confirmation(),
    ).decider,
  ).toBe(allowed ? "role:pm" : "human");
});

test.each(
  [
    ["security"],
    ["permission"],
    ["numeric_rule"],
    ["security", "permission", "numeric_rule"],
  ].map((tags) => ({ tags: tags as RiskTag[] })),
)(
  "risk tags $tags allow PM merge only with a current independent pass, gate and notice",
  async ({ tags }) => {
    const { f, confirmation, check, resolve } = await setup(tags);
    expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(true);
    expect(confirmation().decider).toBe("role:pm");
    expect(resolve().ok).toBe(false);
    check("failed");
    expect(resolve().ok).toBe(false);
    check("passed");
    expect(pmMergeBlockers(f.state, confirmation())).toEqual([]);
    expect(resolve(f.state, " ").ok).toBe(false);
    f.commit(resolve());
    expect(confirmation().resolution).toMatchObject({
      option: "merge",
      via: "delegated",
      notice: "复核和检查已通过。",
    });
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  },
);

type Scenario = {
  name: string;
  change: (s: CommandState, item: WorkItem) => CommandState;
};
const scenarios: Scenario[] = [
  {
    name: "missing verifier",
    change: (s, w) => ({
      ...s,
      work_items: s.work_items.filter((i) => i.id !== w.id),
    }),
  },
  ...(
    [
      ["optional", { required: false }],
      ["cancelled", { status: "cancelled" }],
      [
        "replaced but still passed",
        { replaced_by_work_item_id: id("work_item", 999) },
      ],
      ["not passed", { status: "ready" }],
      ["another card", { card_id: id("card", 999) }],
      ["no produce target", { target_work_item_id: undefined }],
    ] as const
  ).map(
    ([name, change]): Scenario => ({
      name,
      change: (s, w) => ({
        ...s,
        work_items: s.work_items.map((i) =>
          i.id === w.id ? ({ ...i, ...change } as WorkItem) : i,
        ),
      }),
    }),
  ),
  {
    name: "missing review",
    change: (s, w) => ({
      ...s,
      reviews: s.reviews.filter((r) => r.work_item_id !== w.id),
    }),
  },
  ...(
    [
      ["stale SHA", { target_sha: "f".repeat(40) }],
      [
        "withdrawn",
        { withdrawn: { at: "2026-01-01T01:00:00Z", rationale: "Recheck" } },
      ],
      ["conditional", { verdict: "conditional" }],
      ["reject", { verdict: "reject" }],
    ] as const
  ).map(
    ([name, change]): Scenario => ({
      name,
      change: (s, w) => ({
        ...s,
        reviews: s.reviews.map((r) =>
          r.work_item_id === w.id ? { ...r, ...change } : r,
        ),
      }),
    }),
  ),
  {
    name: "newer rejection supersedes pass",
    change: (s, w) => {
      const r = s.reviews.find((r) => r.work_item_id === w.id);
      if (!r) throw new Error("Missing review");
      return {
        ...s,
        reviews: [
          { ...r, id: id("review", 999), verdict: "reject" },
          ...s.reviews,
        ],
      };
    },
  },
  {
    name: "same SHA redelivered",
    change: (s, w) => {
      const v = s.deliveries.find(
        (v) => v.kind === "code" && v.work_item_id === w.target_work_item_id,
      );
      if (!v) throw new Error("Missing product");
      return {
        ...s,
        deliveries: [
          ...s.deliveries,
          { ...v, id: id("delivery", 999), supersedes: v.id },
        ],
      };
    },
  },
];

test.each(
  scenarios.flatMap((scenario) =>
    [false, true].map((multiple) => ({ ...scenario, multiple })),
  ),
)(
  "$name cannot be replaced by a passed checklist label or another product (multiple=$multiple)",
  async ({ change, multiple }) => {
    const { f, item, extra, confirmation, check, resolve } = await setup(
      undefined,
      true,
      multiple,
    );
    if (!item) throw new Error("Missing independent verifier");
    check("passed");
    // Leave the real projection passed too: it is not the authority source.
    const state = change(f.state, extra?.item ?? item);
    expect(riskTagAutoMergeAllowed(state, confirmation())).toBe(false);
    expect(pmMergeBlockers(state, confirmation())).toContain(
      "高危交付须有当前有效的必需独立复核",
    );
    expect(resolve(state).ok).toBe(false);
    // Re-created confirmations use the same gate when selecting their owner.
    const renewed = assignDecision(
      new CommandDraft(state, human, "request_merge", f.io),
      confirmation(),
    );
    expect(renewed.decider).toBe("human");
    const preferences = [{ id: state.project_id, auto_merge_after_minutes: 1 }];
    expect(
      autoMergeSchedule(
        {
          ...state,
          project_preferences: preferences,
          decisions: [{ ...confirmation(), decider: "human" }],
        },
        confirmation().id,
      ).ok,
    ).toBe(false);
  },
);

test.each(["独立　复核", "独立複核"])(
  "ordinary checklist %s cannot authorize a tagged card",
  async (label) => {
    const { f, tag, confirmation, check, resolve } = await setup([], false);
    check("passed");
    f.commit(
      updateCard(
        f.state,
        human,
        {
          card_id: f.card.id,
          pre_merge_check: { label, status: "passed" },
        },
        f.io,
      ),
    );
    tag(["permission"]);
    expect(confirmation().decider).toBe("human");
    expect(resolve().ok).toBe(false);
    expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
  },
);

test.each<DecisionCategory>([
  "spending",
  "account",
  "account",
  "data_deletion",
  "credential",
])(
  "business decision %s takes precedence over a permission code-risk review",
  async (category) => {
    const { f, confirmation, check, resolve } = await setup();
    check("passed");
    f.commit(
      requestDecision(
        f.state,
        human,
        {
          card_id: f.card.id,
          category,
          kind: "choose",
          question: "Business authorization?",
          context: "Different from code review",
          options: [{ key: "yes", description: "Yes", impact: "Change" }],
          recommended: "yes",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        f.io,
      ),
    );
    expect(confirmation().decider).toBe("human");
    expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
    expect(resolve().ok).toBe(false);
  },
);

test.each([false, true])(
  "sensitive flag wins even after a PM confirmation (%s)",
  async (confirmed) => {
    const { f, confirmation, check, resolve } = await setup();
    check("passed");
    if (confirmed) f.commit(resolve());
    f.commit(
      setCardSensitive(
        f.state,
        human,
        { card_id: f.card.id, sensitive: true },
        f.io,
      ),
    );
    expect(confirmation()).toMatchObject({ decider: "human", status: "open" });
    expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
    expect(resolve().ok).toBe(false);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  },
);

test("a human-required handoff is not reopened by an independent pass", async () => {
  const { f, confirmation, check, resolve } = await setup();
  check("passed");
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "对外发布须交人",
        escalate: true,
      },
      f.io,
    ),
  );
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(confirmation().human_required_reason).toContain("对外发布");
  expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
  expect(resolve().ok).toBe(false);
});

test("ordinary cards retain PM confirmation without independent review", async () => {
  const { f, confirmation, check, resolve } = await setup([], false);
  expect(confirmation().decider).toBe("role:pm");
  check("passed");
  expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(true);
  f.commit(resolve());
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("passing independent review does not waive opt-out or other verification", async () => {
  const { f, confirmation, check, resolve } = await setup();
  check("passed");
  const state: CommandState = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.kind === "verify" && w.role_id === "reviewer"
        ? { ...w, required: false, status: "failed" }
        : w,
    ),
  };
  expect(resolve(state).ok).toBe(false);
  const mustFix: CommandState = {
    ...f.state,
    reviews: f.state.reviews.map((r) => ({
      ...r,
      issues: [
        {
          severity: "major",
          impact: "functional" as const,
          must_fix: true,
          pre_existing: false,
          description: "Unresolved",
        },
      ],
    })),
  };
  expect(resolve(mustFix).ok).toBe(false);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: false },
      f.io,
    ),
  );
  expect(confirmation().decider).toBe("human");
  expect(resolve().ok).toBe(false);
});

test("risk tags cannot grant authority to absent PM Ops or unsupported categories", async () => {
  const { f, confirmation, resolve, check } = await setup();
  check("passed");
  const withoutOps = {
    ...f.state,
    assignments: f.state.assignments.filter((a) => a.id !== ops.id),
  };
  expect(
    assignDecision(
      new CommandDraft(withoutOps, human, "request_merge", f.io),
      confirmation(),
    ).decider,
  ).toBe("human");
  expect(resolve(withoutOps).ok).toBe(false);
  const invalidTags: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      risk_tags: ["unknown" as RiskTag],
    })),
  };
  expect(riskTagAutoMergeAllowed(invalidTags, confirmation())).toBe(true);
  expect(resolve(invalidTags).ok).toBe(true);
});

test("source and affected-card business permissions still require the human", async () => {
  const { f, confirmation, check, resolve } = await setup();
  check("passed");
  const decision = f.commit(
    requestDecision(
      f.state,
      human,
      {
        category: "account",
        kind: "choose",
        question: "Grant tool access?",
        context: "Business authorization",
        options: [{ key: "yes", description: "Grant", impact: "Access" }],
        recommended: "yes",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
      },
      f.io,
    ),
  );
  const fromSource: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      source: { kind: "decision", decision_id: decision.id },
    })),
  };
  const affected: CommandState = {
    ...f.state,
    decisions: f.state.decisions.map((q) =>
      q.id === decision.id ? { ...q, affected_cards: [f.card.id] } : q,
    ),
  };
  for (const state of [fromSource, affected]) {
    expect(riskTagAutoMergeAllowed(state, confirmation())).toBe(false);
    expect(resolve(state).ok).toBe(false);
  }
});

async function authorize(
  fixture: Awaited<ReturnType<typeof setup>>,
  mode: "pm" | "timeout" | "human",
) {
  const { f, confirmation, resolve } = fixture;
  if (mode === "pm") f.commit(resolve());
  else if (mode === "human")
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: confirmation().id,
          option: "merge",
          rationale: "人工确认",
          raw_quote: "合并",
        },
        f.io,
      ),
    );
  else {
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        {
          pm_merge_confirmation: false,
          auto_merge_after_minutes: 1,
        },
        f.io,
      ),
    );
    f.commit(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: confirmation().id },
        {
          ...f.io,
          clock: {
            now: () => new Date(Date.parse(now) + 120_000).toISOString(),
          },
        },
      ),
    );
  }
}

test.each(["pm", "timeout"] as const)(
  "adding a risk tag supersedes an unpublished %s authorization without independent review",
  async (mode) => {
    const fixture = await setup([], false);
    const { f, confirmation, check } = fixture;
    check("passed");
    await authorize(fixture, mode);
    const old = confirmation();
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    f.commit(
      updateCard(
        f.state,
        human,
        { card_id: f.card.id, risk_tags: ["security"], high_risk: true },
        f.io,
      ),
    );
    const next = confirmation();
    expect(next).toMatchObject({
      status: "open",
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      amends: old.id,
    });
    expect(f.state.decisions.find((q) => q.id === old.id)).toMatchObject({
      status: "superseded",
      resolution: old.resolution,
    });
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    expect(autoMergeSchedule(f.state, next.id).ok).toBe(false);
    expect(f.state.events).toContainEqual(
      expect.objectContaining({
        type: "decision_requested",
        payload: expect.objectContaining({ decision_id: next.id }),
      }),
    );
    expect(f.state.events).toContainEqual(
      expect.objectContaining({
        type: "decision_superseded",
        payload: expect.objectContaining({
          decision_id: old.id,
          replacement_decision_id: next.id,
        }),
      }),
    );
    // Restoring ordinary status must not resurrect the superseded authority.
    f.commit(
      updateCard(
        f.state,
        human,
        { card_id: f.card.id, risk_tags: [], high_risk: false },
        f.io,
      ),
    );
    expect(confirmation().id).toBe(next.id);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  },
);

test.each(
  (["open", "snoozed", "pm", "timeout"] as const).flatMap((phase) =>
    [false, true].map((multiple) => ({ phase, multiple })),
  ),
)(
  "removing required review hands the $phase confirmation to the human atomically (multiple=$multiple)",
  async ({ phase, multiple }) => {
    const fixture = await setup(undefined, true, multiple);
    const { f, confirmation, check } = fixture;
    const item = fixture.extra?.item ?? fixture.item;
    if (!item) throw new Error("Missing independent review");
    check("passed");
    if (phase === "pm" || phase === "timeout") await authorize(fixture, phase);
    if (phase === "snoozed")
      f.commit(
        resolveDelegatedDecision(
          f.state,
          opsActor,
          {
            decision_id: confirmation().id,
            option: "hold",
            rationale: "Later",
          },
          f.io,
        ),
      );
    const old = confirmation();
    f.commit(
      updateWorkItem(
        f.state,
        opsActor,
        { work_item_id: item.id, required: false },
        f.io,
      ),
    );
    expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
    expect(confirmation().decider).toBe("human");
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    const newRequest = f.state.events
      .filter((e) => e.type === "decision_requested")
      .at(-1);
    expect(newRequest?.payload).toMatchObject({
      decision_id: confirmation().id,
    });
    if (phase === "pm" || phase === "timeout") {
      expect(confirmation()).toMatchObject({ status: "open", amends: old.id });
      expect(f.state.decisions.find((q) => q.id === old.id)).toMatchObject({
        status: "superseded",
        resolution: old.resolution,
      });
    } else {
      expect(confirmation()).toMatchObject({ id: old.id, status: old.status });
      expect(newRequest?.payload).toMatchObject({
        previous_decider: "role:pm",
      });
    }
    // Restoring full coverage cannot resurrect a superseded authorization.
    if (phase === "pm" || phase === "timeout") {
      const next = confirmation();
      f.commit(
        updateWorkItem(
          f.state,
          opsActor,
          { work_item_id: item.id, required: true },
          f.io,
        ),
      );
      expect(confirmation().id).toBe(next.id);
      expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    }
    // The human can finish the flow using their own confirmation.
    await authorize(fixture, "human");
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  },
);

test.each(
  [false, true].flatMap((confirmed) =>
    [false, true].map((multiple) => ({ confirmed, multiple })),
  ),
)(
  "withdrawing review also hands over an unpublished merge (confirmed=$confirmed, multiple=$multiple)",
  async ({ confirmed, multiple }) => {
    const fixture = await setup(undefined, true, multiple);
    const { f, confirmation, check } = fixture;
    const { item, owner } = fixture.extra ?? fixture;
    if (!item || !owner) throw new Error("Missing independent review");
    check("passed");
    if (confirmed) await authorize(fixture, "pm");
    const old = confirmation();
    f.commit(
      withdrawReview(
        f.state,
        f.actor(owner),
        { work_item_id: item.id, rationale: "发现遗漏" },
        f.io,
      ),
    );
    expect(confirmation().decider).toBe("human");
    expect(confirmation().id === old.id).toBe(!confirmed);
    expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  },
);

test.each(
  (["pm", "timeout"] as const).flatMap((mode) =>
    [false, true].map((multiple) => ({ mode, multiple })),
  ),
)(
  "publication rechecks all products after $mode authorization (multiple=$multiple)",
  async ({ mode, multiple }) => {
    const fixture = await setup(undefined, true, multiple);
    const { f, confirmation, check } = fixture;
    const item = fixture.extra?.item ?? fixture.item;
    if (!item) throw new Error("Missing independent review");
    check("passed");
    await authorize(fixture, mode);
    const stale: CommandState = {
      ...f.state,
      work_items: f.state.work_items.map((w) =>
        w.id === item.id ? { ...w, required: false } : w,
      ),
    };
    expect(confirmation().status).toBe("resolved");
    expect(mergePlan(stale, f.card.id)).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("旧代理确认不能用于合并"),
      },
    });
  },
);

test("losing coverage of a second product retains a human's personal confirmation", async () => {
  const fixture = await setup(undefined, true, true);
  const { f, extra, confirmation, check } = fixture;
  if (!extra) throw new Error("Missing second product");
  check("passed");
  await authorize(fixture, "human");
  const old = confirmation();
  f.commit(
    updateWorkItem(
      f.state,
      opsActor,
      { work_item_id: extra.item.id, required: false },
      f.io,
    ),
  );
  expect(riskTagAutoMergeAllowed(f.state, confirmation())).toBe(false);
  expect(confirmation()).toEqual(old);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("a legacy PM-held ineligible confirmation can still be escalated safely", async () => {
  const { f, item, confirmation, check } = await setup();
  if (!item) throw new Error("Missing independent review");
  check("passed");
  const stale: CommandState = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === item.id ? { ...w, required: false } : w,
    ),
  };
  f.commit(
    resolveDelegatedDecision(
      stale,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "复核资格已变化",
        escalate: true,
      },
      f.io,
    ),
  );
  expect(confirmation()).toMatchObject({
    status: "open",
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    human_required_reason: expect.stringContaining("复核资格已变化"),
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
});

test("eligibility updates retain a human's personal confirmation and a still-eligible PM authorization", async () => {
  for (const mode of ["pm", "human"] as const) {
    const fixture = await setup([], mode === "pm");
    const { f, confirmation, check } = fixture;
    check("passed");
    await authorize(fixture, mode);
    const old = confirmation();
    f.commit(
      updateCard(
        f.state,
        human,
        { card_id: f.card.id, risk_tags: ["security"], high_risk: true },
        f.io,
      ),
    );
    expect(confirmation()).toEqual(old);
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  }
});

test("an ineligible handoff requires a personal human answer, not Office transcription", async () => {
  const fixture = await setup([], false);
  const { f, confirmation, check } = fixture;
  check("passed");
  f.commit(
    updateCard(
      f.state,
      human,
      { card_id: f.card.id, risk_tags: ["security"], high_risk: true },
      f.io,
    ),
  );
  const office: Assignment = {
    ...ops,
    id: id("assignment", 901),
    standing_mode: "office",
  };
  const officeActor: Actor = {
    ...opsActor,
    assignment_id: office.id,
    allowed_tools: standingTools(role("pm").allowed_tools, "office"),
  };
  expect(
    recordDecision(
      { ...f.state, assignments: [...f.state.assignments, office] },
      officeActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "转录",
        raw_quote: "合并",
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  await authorize(fixture, "human");
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test.each(["scope_change", "permission"] as const)(
  "human-decided %s still requires every product's independent review",
  async (category) => {
    const { f, product, extra, completion, confirmation, check } = await setup(
      undefined,
      true,
      true,
      category,
    );
    if (!extra) throw new Error("Missing second product");
    check("passed");
    const source = f.state.decisions.find((q) => q.category === category);
    if (!source) throw new Error("Missing decision");
    expect(confirmation().decider).toBe("role:pm");
    const evidence = [product, extra.product].map((v) => ({
      decision_id: source.id,
      option: "yes",
      completion_id: completion.id,
      delivery_id: v.id,
      target_sha: v.subject.value,
      evidence: "当前交付行为与所选方案一致",
    }));
    const answer = (state = f.state) =>
      resolveDelegatedDecision(
        state,
        opsActor,
        {
          decision_id: confirmation().id,
          option: "merge",
          rationale: "逐项核对一致",
          notice: "已核对拍板与独立复核",
          decision_evidence: evidence,
        },
        f.io,
      );
    expect(answer().ok).toBe(true);
    const missing = {
      ...f.state,
      reviews: f.state.reviews.filter((r) => r.work_item_id !== extra.item.id),
    };
    expect(answer(missing).ok).toBe(false);
    f.commit(answer());
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    expect(
      mergePlan({ ...f.state, reviews: missing.reviews }, f.card.id).ok,
    ).toBe(false);
  },
);
