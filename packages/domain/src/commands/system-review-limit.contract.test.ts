import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  beginSystemReviewLimitRaise,
  type CommandState,
  finishSystemReviewLimitRaise,
  recordDecision,
  requestDecision,
  type SystemReviewLimitFailure,
  type SystemReviewLimitProof,
  setProjectPreferences,
  updateWorkItem,
} from "../index.js";
import { mergeNeedsHuman } from "./delegation.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { assignment, human, id, role, value } from "./test-fixtures.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

async function fixture() {
  const f = mergeFixture("confirm", 1);
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "assignments", entity: ops }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      {
        system_review_limit_raise: true,
        system_review_limit_max_raises: 1,
        role_rule_paths: ["packages/roles/**", "AGENTS.md", "CLAUDE.md"],
      },
      f.io,
    ),
  );
  const first = await f.deliver();
  f.review(first);
  const target = await f.deliver("code", "b".repeat(40));
  const decision = f.state.decisions.find((q) => q.trigger === "review_limit");
  if (!decision) throw new Error("Missing review-limit decision");
  const system: Actor = { kind: "system", project_id: f.state.project_id };
  const pm: Actor = {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: ops.id,
    ...role("pm"),
  };
  const claim = (state = f.state) =>
    beginSystemReviewLimitRaise(
      state,
      system,
      { decision_id: decision.id },
      f.io,
    );
  const pause = (option: "pause" | "escalate" | "raise_limit") =>
    f.commit(
      updateWorkItem(
        f.state,
        pm,
        {
          work_item_id: required(f.reviewer.work_item_id),
          review_limit_decision: {
            decision_id: decision.id,
            option,
            rationale: "人工判断",
          },
        },
        f.io,
      ),
    );
  const claimed = () => {
    const c = f.commit(claim());
    if (!c) throw new Error("Not eligible");
    return c;
  };
  const proof = (c: ReturnType<typeof claimed>): SystemReviewLimitProof => ({
    candidate: c.candidate,
    base_sha: "c".repeat(40),
    merged_tree: "d".repeat(40),
    delivery_tree: "d".repeat(40),
    changed_paths: ["app.ts"],
  });
  return {
    f,
    first,
    target,
    decision,
    system,
    pm,
    claim,
    claimed,
    proof,
    pause,
  };
}

test("C-239: system adds one round, audits both SHAs, and requires a new pass; cap survives a later delivery", async () => {
  const x = await fixture();
  const c = x.claimed();
  const input = { attempt_id: c.attempt_id, proof: x.proof(c) };
  x.f.commit(finishSystemReviewLimitRaise(x.f.state, x.system, input, x.f.io));
  expect(x.f.state.decisions.find((q) => q.id === x.decision.id)).toMatchObject(
    {
      status: "resolved",
      resolution: { resolved_by: "system", option: "raise_limit" },
    },
  );
  expect(
    x.f.state.work_items.find((w) => w.id === x.f.reviewer.work_item_id),
  ).toMatchObject({ max_review_rounds: 2, status: "ready" });
  expect(x.f.state.reviews).toHaveLength(1);
  expect(
    x.f.state.deliveries.find((v) => v.id === x.target.id)?.status,
  ).not.toBe("accepted");
  expect(
    x.f.state.events.find((e) => e.type === "system_review_limit_raised"),
  ).toMatchObject({
    actor: x.system,
    payload: {
      previous_sha: x.first.subject.value,
      delivery_sha: x.target.subject.value,
      base_sha: "c".repeat(40),
    },
  });
  expect(
    x.f.state.timeline.some(
      (t) => t.author === "system" && t.decision_id === x.decision.id,
    ),
  ).toBe(true);
  expect(
    value(finishSystemReviewLimitRaise(x.f.state, x.system, input, x.f.io))
      .changes,
  ).toEqual([]);
  expect(value(x.claim()).data).toBeNull();
  x.f.review(x.target);
  expect(
    x.f.state.work_items.find((w) => w.id === x.f.reviewer.work_item_id)
      ?.status,
  ).toBe("passed");
  await x.f.deliver("code", "e".repeat(40));
  const next = required(
    x.f.state.decisions.findLast((q) => q.trigger === "review_limit"),
  );
  expect(
    value(
      beginSystemReviewLimitRaise(
        x.f.state,
        x.system,
        { decision_id: next.id },
        x.f.io,
      ),
    ).data,
  ).toBeNull();
});

test.each(["pause", "escalate", "raise_limit"] as const)(
  "PM %s before or during proof prevents system action",
  async (option) => {
    const x = await fixture();
    const c = x.claimed();
    x.pause(option);
    const afterPm = x.f.state.work_items;
    expect(value(x.claim()).data).toBeNull();
    x.f.commit(
      finishSystemReviewLimitRaise(
        x.f.state,
        x.system,
        { attempt_id: c.attempt_id, proof: x.proof(c) },
        x.f.io,
      ),
    );
    expect(x.f.state.work_items).toEqual(afterPm);
    expect(
      x.f.state.events.some((e) => e.type === "system_review_limit_raised"),
    ).toBe(false);
    const y = await fixture();
    y.pause(option);
    expect(value(y.claim()).data).toBeNull();
  },
);

const deny: Record<string, (s: CommandState) => CommandState> = {
  disabled: (s) => ({ ...s, project_preferences: [] }),
  "missing limit": (s) => ({
    ...s,
    project_preferences: (s.project_preferences ?? []).map((p) => ({
      ...p,
      system_review_limit_max_raises: null,
    })),
  }),
  "empty paths": (s) => ({
    ...s,
    project_preferences: (s.project_preferences ?? []).map((p) => ({
      ...p,
      role_rule_paths: [],
    })),
  }),
  "invalid paths": (s) => ({
    ...s,
    project_preferences: (s.project_preferences ?? []).map((p) => ({
      ...p,
      role_rule_paths: ["../roles"],
    })),
  }),
  "independent review": (s) => ({
    ...s,
    work_items: s.work_items.map((w) =>
      w.role_id === "reviewer" ? { ...w, role_id: "independent_reviewer" } : w,
    ),
  }),
  "human required": (s) => ({
    ...s,
    decisions: s.decisions.map((q) => ({
      ...q,
      human_required_reason: "交人",
    })),
  }),
  "human decider": (s) => ({
    ...s,
    decisions: s.decisions.map((q) => ({ ...q, decider: "human" })),
  }),
  "no Ops": (s) => ({
    ...s,
    assignments: s.assignments.filter((a) => a.scope !== "standing"),
  }),
  "no delegation": (s) => ({
    ...s,
    project_preferences: (s.project_preferences ?? []).map((p) => ({
      ...p,
      decision_delegation: { general: false },
    })),
  }),
  withdrawn: (s) => ({
    ...s,
    reviews: s.reviews.map((r) => ({
      ...r,
      withdrawn: { at: "2030-01-01", rationale: "撤回" },
    })),
  }),
  "non-pass": (s) => ({
    ...s,
    reviews: s.reviews.map((r) => ({ ...r, verdict: "reject" })),
  }),
  "must fix": (s) => ({
    ...s,
    reviews: s.reviews.map((r) => ({
      ...r,
      issues: [
        {
          severity: "major",
          must_fix: true,
          pre_existing: false,
          description: "fix",
        },
      ],
    })),
  }),
  "review SHA mismatch": (s) => ({
    ...s,
    reviews: s.reviews.map((r) => ({ ...r, target_sha: "f".repeat(40) })),
  }),
  sensitive: (s) => ({
    ...s,
    cards: s.cards.map((c) => ({ ...c, sensitive: true })),
  }),
  "closed card": (s) => ({
    ...s,
    cards: s.cards.map((c) => ({ ...c, status: "done" })),
  }),
  "new delivery SHA": (s) => ({
    ...s,
    deliveries: s.deliveries.map((v) =>
      v.status !== "superseded"
        ? { ...v, subject: { kind: "git_head", value: "f".repeat(40) } }
        : v,
    ),
  }),
};
test.each(Object.keys(deny).filter((k) => k !== "new delivery SHA"))(
  "candidate rejects %s",
  async (name) => {
    const x = await fixture();
    expect(value(x.claim(required(deny[name])(x.f.state))).data).toBeNull();
  },
);
test.each(Object.keys(deny))(
  "settlement rechecks %s after Git IO",
  async (name) => {
    const x = await fixture();
    const c = x.claimed();
    const effect = value(
      finishSystemReviewLimitRaise(
        required(deny[name])(x.f.state),
        x.system,
        { attempt_id: c.attempt_id, proof: x.proof(c) },
        x.f.io,
      ),
    );
    expect(effect.data).toBeNull();
    expect(effect.changes).toEqual([]);
  },
);
test.each([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const)(
  "D12 / scope %s on source excludes automation",
  async (category) => {
    const x = await fixture();
    const { card_id: _card, ...original } = x.decision;
    const source = {
      ...original,
      category,
      affected_cards: [],
      affected_work_items: [],
    };
    const state: CommandState = {
      ...x.f.state,
      decisions: [
        ...x.f.state.decisions,
        { ...source, id: id("decision", 999), key: id("decision", 999) },
      ],
      cards: x.f.state.cards.map((c) => ({
        ...c,
        source: { kind: "decision", decision_id: id("decision", 999) },
      })),
    };
    expect(value(x.claim(state)).data).toBeNull();
  },
);
const answeredContentCases = (
  [
    "spending",
    "account",
    "permission",
    "data_deletion",
    "scope_change",
  ] as const
).flatMap((category) =>
  (["source", "card", "affected"] as const).flatMap((link) =>
    [undefined, false, true].map((preference) => ({
      category,
      link,
      preference,
    })),
  ),
);
test.each(answeredContentCases)(
  "answered $category ($link, merge preference=$preference) blocks claim and settlement",
  async ({ category, link, preference }) => {
    const x = await fixture();
    if (preference !== undefined)
      x.f.commit(
        setProjectPreferences(
          x.f.state,
          human,
          { pm_confirm_human_decided_merges: preference },
          x.f.io,
        ),
      );
    const c = x.claimed();
    const question = x.f.commit(
      requestDecision(
        x.f.state,
        human,
        {
          ...(link === "card" ? { card_id: x.f.card.id } : {}),
          category,
          kind: "choose",
          question: "批准此改动？",
          context: "已有人批准的业务内容",
          options: [{ key: "yes", description: "批准", impact: "按此实施" }],
          recommended: "yes",
          affected_cards: link === "affected" ? [x.f.card.id] : [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: {
            changed: "按已批准方案修改",
            impact: "保持批准的行为",
            risk: "无",
          },
        },
        x.f.io,
      ),
    );
    x.f.commit(
      recordDecision(
        x.f.state,
        human,
        {
          decision_id: question.id,
          option: "yes",
          rationale: "批准",
          raw_quote: "同意",
        },
        { ...x.f.io, human_confirmation: "workbench" },
      ),
    );
    const state: CommandState = {
      ...x.f.state,
      cards: x.f.state.cards.map((card) =>
        link === "source" && card.id === x.f.card.id
          ? { ...card, source: { kind: "decision", decision_id: question.id } }
          : card,
      ),
    };
    expect(state.decisions.find((q) => q.id === question.id)).toMatchObject({
      status: "resolved",
      resolution: { resolved_by: "human", via: "needs_you", option: "yes" },
    });
    // C-309 may allow a PM merge, but cannot authorize C-239 automatic rounds.
    expect(
      !!mergeNeedsHuman(
        state.decisions,
        state.cards,
        x.f.card.id,
        state.project_preferences?.find((p) => p.id === state.project_id),
      ),
    ).toBe(
      preference === false ||
        !["permission", "scope_change"].includes(category),
    );
    // Remove the prior claim so this assertion exercises eligibility, not deduplication.
    const claim = value(
      x.claim({
        ...state,
        events: state.events.filter((e) => e.id !== c.attempt_id),
      }),
    );
    expect(claim.data).toBeNull();
    expect(claim.events).toEqual([]);
    const settled = value(
      finishSystemReviewLimitRaise(
        state,
        x.system,
        { attempt_id: c.attempt_id, proof: x.proof(c) },
        x.f.io,
      ),
    );
    expect(settled.data).toBeNull();
    expect(settled.changes).toEqual([]);
    expect(settled.events).toEqual([
      expect.objectContaining({
        type: "system_review_limit_checked",
        payload: expect.objectContaining({ accepted: false }),
      }),
    ]);
    expect(state.decisions.find((q) => q.id === x.decision.id)).toMatchObject({
      status: "open",
    });
    expect(
      state.decisions.find((q) => q.id === x.decision.id)?.resolution,
    ).toBeUndefined();
    expect(
      state.work_items.find((w) => w.id === x.f.reviewer.work_item_id),
    ).toMatchObject({ max_review_rounds: 1, status: "waiting_decision" });
  },
);

test.each(["missing", "different tree", "role paths", "wrong target"])(
  "rejects %s proof and never retries that decision",
  async (mode) => {
    const x = await fixture();
    const c = x.claimed();
    const valid = x.proof(c);
    let proof: SystemReviewLimitProof | null = valid;
    if (mode === "missing") proof = null;
    if (mode === "different tree")
      proof = { ...valid, delivery_tree: "e".repeat(40) };
    if (mode === "role paths")
      proof = { ...valid, changed_paths: ["packages/roles/src/role-pack.ts"] };
    if (mode === "wrong target")
      proof = {
        ...valid,
        candidate: { ...c.candidate, delivery_sha: "e".repeat(40) },
      };
    const effect = x.f.commit(
      finishSystemReviewLimitRaise(
        x.f.state,
        x.system,
        { attempt_id: c.attempt_id, proof },
        x.f.io,
      ),
    );
    expect(effect).toBeNull();
    expect(value(x.claim()).data).toBeNull();
  },
);
test("system-only commands cannot be called by human or assignment actors", async () => {
  const x = await fixture();
  const c = x.claimed();
  for (const actor of [human, x.pm, x.f.actor(x.f.coder)]) {
    expect(
      beginSystemReviewLimitRaise(
        x.f.state,
        actor,
        { decision_id: x.decision.id },
        x.f.io,
      ).ok,
    ).toBe(false);
    expect(
      finishSystemReviewLimitRaise(
        x.f.state,
        actor,
        { attempt_id: c.attempt_id, proof: x.proof(c) },
        x.f.io,
      ).ok,
    ).toBe(false);
  }
});
test("preferences have no defaults; only human can configure; invalid values leave no partial effect", async () => {
  const x = await fixture();
  for (const limit of [
    0,
    -1,
    1.1,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
  ]) {
    expect(
      setProjectPreferences(
        x.f.state,
        human,
        { system_review_limit_max_raises: limit as number },
        x.f.io,
      ).ok,
    ).toBe(false);
  }
  for (const paths of [
    ["../roles"],
    ["/roles"],
    ["roles/*"],
    ["roles/**/x"],
    [""],
    "roles",
    [1],
  ]) {
    expect(
      setProjectPreferences(
        x.f.state,
        human,
        { role_rule_paths: paths as string[] },
        x.f.io,
      ).ok,
    ).toBe(false);
  }
  for (const actor of [x.system, x.pm])
    expect(
      setProjectPreferences(
        x.f.state,
        actor,
        { system_review_limit_raise: true },
        x.f.io,
      ).ok,
    ).toBe(false);
  const clear = x.f.commit(
    setProjectPreferences(
      x.f.state,
      human,
      { system_review_limit_max_raises: null, role_rule_paths: null },
      x.f.io,
    ),
  );
  expect(clear.system_review_limit_max_raises).toBeNull();
  expect(value(x.claim()).data).toBeNull();
});

test("shadow preferences and review-limit authorization remain independent through updates and clears", async () => {
  const x = await fixture();
  const noOp = value(
    setProjectPreferences(
      x.f.state,
      human,
      { system_merge_shadow: false, system_merge_shadow_policy: null },
      x.f.io,
    ),
  );
  expect(noOp.changes).toEqual([]);
  expect(noOp.events).toEqual([]);
  const policy = {
    role_rule_paths: ["roles/**"],
    release_paths: ["publish/**"],
  };
  const enabled = x.f.commit(
    setProjectPreferences(
      x.f.state,
      human,
      { system_merge_shadow: true, system_merge_shadow_policy: policy },
      x.f.io,
    ),
  );
  expect(enabled).toMatchObject({
    system_merge_shadow: true,
    system_merge_shadow_policy: policy,
    system_review_limit_raise: true,
    system_review_limit_max_raises: 1,
    role_rule_paths: ["packages/roles/**", "AGENTS.md", "CLAUDE.md"],
  });
  expect(value(x.claim()).data).not.toBeNull();
  const cleared = value(
    setProjectPreferences(
      x.f.state,
      human,
      {
        system_review_limit_raise: false,
        system_review_limit_max_raises: null,
        role_rule_paths: null,
      },
      x.f.io,
    ),
  );
  expect(cleared.data).toMatchObject({
    system_merge_shadow: true,
    system_merge_shadow_policy: policy,
    system_review_limit_raise: false,
    system_review_limit_max_raises: null,
    role_rule_paths: null,
  });
  expect(cleared.events.map((e) => e.payload)).toEqual([
    expect.objectContaining({ preference: "system_review_limit_raise" }),
    expect.objectContaining({ preference: "system_review_limit_max_raises" }),
    expect.objectContaining({ preference: "role_rule_paths" }),
  ]);
  x.f.commit({ ok: true, value: cleared });
  expect(value(x.claim()).data).toBeNull();
});

test.each([false, true])(
  "failure diagnostics are allowlisted and cannot grant a round (malformed=%s)",
  async (malformed) => {
    const x = await fixture();
    const c = x.claimed();
    const failure = {
      stage: malformed ? "synthetic-secret" : "baseline",
      category: malformed ? "/private/fixture" : "access_denied",
      message: "Authorization: Bearer synthetic-token",
    } as unknown as SystemReviewLimitFailure;
    const input = { attempt_id: c.attempt_id, proof: x.proof(c), failure };
    const effect = value(
      finishSystemReviewLimitRaise(x.f.state, x.system, input, x.f.io),
    );
    expect(effect.data).toBeNull();
    expect(effect.changes).toEqual([]);
    expect(effect.events).toEqual([
      expect.objectContaining({
        type: "system_review_limit_checked",
        actor: x.system,
        payload: {
          attempt_id: c.attempt_id,
          decision_id: x.decision.id,
          accepted: false,
          failure: {
            stage: malformed ? "proof" : "baseline",
            category: malformed ? "unexpected_error" : "access_denied",
          },
        },
      }),
    ]);
    expect(effect.timeline).toEqual([
      expect.objectContaining({
        author: "system",
        decision_id: x.decision.id,
        work_item_id: c.candidate.work_item_id,
        body: expect.stringContaining("核验失败"),
      }),
    ]);
    expect(JSON.stringify(effect)).not.toMatch(
      /synthetic|private|Authorization|Bearer/,
    );
    x.f.commit({ ok: true, value: effect });
    expect(value(x.claim()).data).toBeNull();
    expect(
      value(finishSystemReviewLimitRaise(x.f.state, x.system, input, x.f.io))
        .events,
    ).toEqual([]);
  },
);
