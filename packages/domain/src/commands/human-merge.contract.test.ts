import { expect, test } from "vitest";
import {
  type CommandState,
  type Decision,
  humanMergeBlockers,
  listNeedsYou,
  mergePlan,
  optionalPendingVerifiers,
  pmMergeBlockers,
  recordDecision,
  recordMergeCheck,
  requestDecision,
  systemMergeBlockers,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, assignment, human, id, role, value } from "./test-fixtures.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}

async function setup() {
  const f = mergeFixture();
  const { product, completion } = await f.accept();
  const q = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
  if (!q) throw new Error("Missing confirmation");
  f.commit(
    updateCard(
      f.state,
      human,
      {
        card_id: f.card.id,
        pre_merge_check: { label: "截图核对", status: "passed" },
      },
      f.io,
    ),
  );
  const check = (
    status: "queued" | "running" | "passed",
    attempt = "first",
  ) => {
    const identity = {
      card_id: f.card.id,
      completion_id: completion.id,
      attempt_id: attempt,
      candidate_sha: "b".repeat(40),
      tree_sha: (attempt === "first" ? "c" : "d").repeat(40),
    };
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        { kind: "system", project_id: human.project_id },
        status === "passed"
          ? {
              ...identity,
              status,
              checks: [
                {
                  name: "test",
                  status: "passed",
                  exit_code: 0,
                  duration_ms: 1,
                },
              ],
              summary: "Passed",
              log_ref: `${attempt}.log`,
            }
          : { ...identity, status },
        f.io,
      ),
    );
  };
  check("queued");
  check("running");
  check("passed");
  const confirm = (
    state: CommandState,
    decision: Decision = q,
    option = "merge",
  ) =>
    recordDecision(
      state,
      human,
      {
        decision_id: decision.id,
        option,
        rationale: "人工选择",
        raw_quote: "人工选择",
      },
      f.io,
    );
  return {
    f,
    product,
    completion,
    q,
    check,
    confirm,
    get state(): CommandState {
      return { ...f.state, project_settings: { merge_gate_enabled: true } };
    },
  };
}

test("C-264: all checks allow confirmation and expose identical empty blockers", async () => {
  const s = await setup();
  expect(humanMergeBlockers(s.state, s.q)).toEqual([]);
  const view = value(listNeedsYou(s.state, human)).data.decisions.find(
    (q) => q.id === s.q.id,
  );
  expect(view?.merge_confirmation?.blockers).toEqual([]);
  expect(s.confirm(s.state).ok).toBe(true);
});

const failures: {
  name: string;
  mutate: (state: CommandState) => CommandState;
  reason: string;
}[] = [
  {
    name: "verifier status",
    mutate: (s) => ({
      ...s,
      work_items: s.work_items.map((w) =>
        w.kind === "verify" ? { ...w, status: "ready" } : w,
      ),
    }),
    reason: "未通过当前交付审核",
  },
  {
    name: "missing review despite passed status",
    mutate: (s) => ({ ...s, reviews: [] }),
    reason: "未通过当前交付审核",
  },
  {
    name: "withdrawn review",
    mutate: (s) => ({
      ...s,
      reviews: s.reviews.map((r) => ({
        ...r,
        withdrawn: { at: "2026-11-14T00:00:00Z", rationale: "重新核对" },
      })),
    }),
    reason: "未通过当前交付审核",
  },
  {
    name: "wrong SHA",
    mutate: (s) => ({
      ...s,
      reviews: s.reviews.map((r) => ({ ...r, target_sha: "f".repeat(40) })),
    }),
    reason: "未通过当前交付审核",
  },
  {
    // C-768: an optional one is waived by confirming (see the tests below).
    name: "added required verifier",
    mutate: (s) => ({
      ...s,
      work_items: [
        ...s.work_items,
        {
          ...required(s.work_items.find((w) => w.kind === "verify")),
          id: id("work_item", 100),
          title: "追加检查",
          required: true,
          status: "ready",
        },
      ],
    }),
    reason: "追加检查（W-100）：未通过当前交付审核",
  },
  {
    name: "independent verifier",
    mutate: (s) => ({
      ...s,
      work_items: [
        ...s.work_items,
        {
          ...required(s.work_items.find((w) => w.kind === "verify")),
          id: id("work_item", 100),
          role_id: "independent_reviewer",
          title: "独立复核",
          status: "ready",
        },
      ],
    }),
    reason: "独立复核",
  },
  ...(["pending", "failed"] as const).map((status) => ({
    name: `pre-merge ${status}`,
    mutate: (s: CommandState): CommandState => ({
      ...s,
      cards: s.cards.map((c) => ({
        ...c,
        pre_merge_checks:
          c.pre_merge_checks?.map((check) => ({ ...check, status })) ?? [],
      })),
    }),
    reason: "截图核对",
  })),
  {
    name: "stale pre-merge check",
    mutate: (s) => ({
      ...s,
      cards: s.cards.map((c) => ({
        ...c,
        pre_merge_checks:
          c.pre_merge_checks?.map((check) => ({
            ...check,
            checked_versions: [],
          })) ?? [],
      })),
    }),
    reason: "当前交付需重新核对",
  },
  {
    name: "missing merge check",
    mutate: (s) => ({
      ...s,
      events: s.events.filter((e) => !e.type.startsWith("merge_check_")),
    }),
    reason: "合并检查：尚无结果",
  },
  {
    name: "must fix",
    mutate: (s) => ({
      ...s,
      reviews: s.reviews.map((r) => ({
        ...r,
        issues: [
          {
            severity: "major",
            description: "必须修复",
            must_fix: true,
            pre_existing: false,
          },
        ],
      })),
    }),
    reason: "必须修复项",
  },
];

test.each(failures)(
  "C-264: $name alone refuses merge but leaves hold and return available",
  async ({ mutate, reason }) => {
    const s = await setup();
    const state = mutate(s.state);
    const before = JSON.stringify(state);
    const blockers = humanMergeBlockers(state, s.q);
    expect(blockers.join("\n")).toContain(reason);
    const view = value(listNeedsYou(state, human)).data.decisions.find(
      (q) => q.id === s.q.id,
    );
    expect(view?.merge_confirmation?.blockers).toEqual(blockers);
    expect(s.confirm(state)).toMatchObject({
      ok: false,
      error: {
        message: `等待中：\n${blockers.join("\n")}`,
        details: { merge_blockers: blockers },
      },
    });
    expect(JSON.stringify(state)).toBe(before);
    expect(s.confirm(state, s.q, "hold").ok).toBe(true);
    expect(s.confirm(state, s.q, "request_changes").ok).toBe(true);
  },
);

/** C-768: an extra verifier on the product, still in progress, requested by its delivery. */
function withExtraVerifier(
  s: CommandState,
  requiredItem: boolean,
): CommandState {
  const base = required(s.work_items.find((w) => w.kind === "verify"));
  const extra = id("work_item", 100);
  const { template_key: _template, ...item } = base;
  return {
    ...s,
    work_items: [
      ...s.work_items,
      {
        ...item,
        id: extra,
        title: "Google 补录",
        required: requiredItem,
        status: "in_progress",
      },
    ],
    deliveries: s.deliveries.map((v) =>
      v.work_item_id === base.target_work_item_id
        ? { ...v, requested_verifiers: [...v.requested_verifiers, extra] }
        : v,
    ),
  };
}
const autoMerge = (s: CommandState, on: boolean): CommandState => ({
  ...s,
  project_preferences: [
    {
      id: s.project_id,
      auto_merge_after_minutes: null,
      auto_merge: on ? "on" : "off",
      flow_version: 5,
    },
  ],
});

test("C-768: only optional verifiers left — the human confirms directly and the waiver is recorded", async () => {
  const s = await setup();
  const state = withExtraVerifier(s.state, false);
  const waived = [{ id: id("work_item", 100), title: "Google 补录" }];
  expect(humanMergeBlockers(state, s.q)).toEqual([]);
  expect(optionalPendingVerifiers(state, s.q)).toEqual(waived);
  const view = value(listNeedsYou(state, human)).data.decisions.find(
    (q) => q.id === s.q.id,
  );
  expect(view?.merge_confirmation?.blockers).toEqual([]);
  expect(view?.merge_confirmation?.optional_pending).toEqual(waived);
  const effect = value(s.confirm(state));
  expect(effect.data.resolution).toMatchObject({
    option: "merge",
    via: "needs_you",
    waived_verifiers: waived,
  });
  expect(effect.data.resolution).not.toHaveProperty("merge_override");
  expect(effect.events).toContainEqual(
    expect.objectContaining({
      type: "decision_resolved",
      payload: expect.objectContaining({ waived_verifiers: waived }),
    }),
  );
  expect(
    effect.timeline.find((t) => t.type === "decision_resolved")?.body,
  ).toBe("豁免可选验证项：Google 补录（W-100）\n人工选择");
  expect(mergePlan(apply(state, effect), s.f.card.id).ok).toBe(true);
});

test("C-768: nothing is waived when no optional verifier is open", async () => {
  const s = await setup();
  const effect = value(s.confirm(s.state));
  expect(effect.data.resolution).not.toHaveProperty("waived_verifiers");
  expect(
    effect.timeline.find((t) => t.type === "decision_resolved")?.body,
  ).toBe("人工选择");
});

test("C-768: an unfinished required verifier still blocks the human confirmation", async () => {
  const s = await setup();
  const state = withExtraVerifier(s.state, true);
  const blockers = humanMergeBlockers(state, s.q);
  expect(blockers).toEqual(["Google 补录（W-100）：未通过当前交付审核"]);
  expect(optionalPendingVerifiers(state, s.q)).toEqual([]);
  expect(s.confirm(state)).toMatchObject({
    ok: false,
    error: {
      code: "illegal_transition",
      details: { merge_blockers: blockers },
    },
  });
});

test("C-768: a required blocker beside an optional one still needs 仍要合并, which also records the waiver", async () => {
  const s = await setup();
  const state = {
    ...withExtraVerifier(s.state, false),
    events: s.state.events.filter((e) => !e.type.startsWith("merge_check_")),
  };
  expect(humanMergeBlockers(state, s.q)).toEqual(["合并检查：尚无结果"]);
  expect(s.confirm(state).ok).toBe(false);
  const effect = value(
    recordDecision(
      state,
      human,
      {
        decision_id: s.q.id,
        option: "merge",
        rationale: "人工决定",
        raw_quote: "确认",
        merge_override_reason: "已人工核实",
      },
      s.f.io,
    ),
  );
  expect(effect.data.resolution).toMatchObject({
    merge_override: { reason: "已人工核实", blockers: ["合并检查：尚无结果"] },
    waived_verifiers: [{ id: id("work_item", 100), title: "Google 补录" }],
  });
});

test.each([true, false])(
  "C-768: auto_merge=%s — PM Ops and system rules for optional verifiers are unchanged",
  async (on) => {
    const s = await setup();
    const state = withExtraVerifier(autoMerge(s.state, on), false);
    expect(humanMergeBlockers(state, s.q)).toEqual([]);
    expect(pmMergeBlockers(state, s.q)).toContain(
      `验证项 ${id("work_item", 100)} 未通过`,
    );
    // The system drops optional verifiers only when auto-merge is on.
    expect(
      systemMergeBlockers(state, s.q).some((r) => r.includes("W-100")),
    ).toBe(!on);
  },
);

test("C-264: related blocking questions count; the merge confirmation itself does not", async () => {
  const s = await setup();
  const q = s.f.commit(
    requestDecision(
      s.f.state,
      human,
      {
        category: "general",
        kind: "choose",
        question: "需要核实",
        context: "背景",
        options: [{ key: "yes", description: "确认", impact: "继续" }],
        recommended: "yes",
        affected_cards: [s.f.card.id],
        affected_work_items: [],
        blocking: true,
        decider: "human",
        plain_summary: {
          changed: "核实前置事项",
          impact: "完成后继续",
          risk: "无",
        },
      },
      s.f.io,
    ),
  );
  expect(humanMergeBlockers(s.state, s.q)).toContain(`拍板 ${q.id}：尚未解决`);
  expect(s.confirm(s.state).ok).toBe(false);
  const unblocked = {
    ...s.state,
    decisions: s.state.decisions.map((d) =>
      d.id === q.id ? { ...d, blocking: false } : d,
    ),
  };
  expect(s.confirm(unblocked).ok).toBe(true);
});

test("C-264: a new candidate immediately invalidates the previous passed check", async () => {
  const s = await setup();
  s.check("queued", "next");
  expect(humanMergeBlockers(s.state, s.q)).toEqual(["合并检查：排队中"]);
  expect(s.confirm(s.state).ok).toBe(false);
  s.check("running", "next");
  expect(humanMergeBlockers(s.state, s.q)).toEqual(["合并检查：运行中"]);
  s.check("passed", "next");
  expect(s.confirm(s.state).ok).toBe(true);
});

test("C-264: redelivery requires new reviews and a new completion check", async () => {
  const s = await setup();
  s.f.commit(s.confirm(s.state, s.q, "request_changes"));
  const product = await s.f.deliver("code", "e".repeat(40));
  expect(s.confirm(s.state).ok).toBe(false);
  s.f.review(product);
  const completion = await s.f.deliver(
    "card_completion",
    product.subject.value,
  );
  s.f.review(completion);
  const current = s.f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation" && q.status === "open",
  );
  if (!current) throw new Error("Missing new confirmation");
  expect(humanMergeBlockers(s.state, current)).toEqual([
    "截图核对：待核（当前交付需重新核对）",
    "合并检查：尚无结果",
  ]);
  expect(s.confirm(s.state, current).ok).toBe(false);
  expect(s.confirm(s.state).ok).toBe(false);
});

test("C-264: cancelled optional checks and pre-existing issues do not add blockers", async () => {
  const s = await setup();
  const state = required(
    failures.find((f) => f.name === "added required verifier"),
  ).mutate(s.state);
  const cancelled: CommandState = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", 100) ? { ...w, status: "cancelled" } : w,
    ),
    reviews: state.reviews.map((r) => ({
      ...r,
      issues: [
        {
          severity: "minor",
          description: "已有问题",
          must_fix: true,
          pre_existing: true,
        },
      ],
    })),
  };
  expect(s.confirm(cancelled).ok).toBe(true);
});

test("Q-440: only an explicit human override with a reason bypasses blockers and records evidence", async () => {
  const s = await setup();
  s.check("queued", "next");
  const input = {
    decision_id: s.q.id,
    option: "merge",
    rationale: "人工决定",
    raw_quote: "确认",
    merge_override_reason: "已人工核实",
  };
  const answer = (reason: string) =>
    recordDecision(
      s.state,
      human,
      { ...input, merge_override_reason: reason },
      s.f.io,
    );
  expect(answer("").ok).toBe(false);
  expect(answer("  ").ok).toBe(false);
  const effect = value(answer("已人工核实"));
  const evidence = { reason: "已人工核实", blockers: ["合并检查：排队中"] };
  expect(effect.data.resolution?.merge_override).toEqual(evidence);
  expect(effect.events).toContainEqual(
    expect.objectContaining({
      type: "decision_resolved",
      payload: expect.objectContaining({
        merge_override: evidence,
        via: "needs_you",
      }),
    }),
  );
  expect(
    effect.timeline.some(
      (t) =>
        t.body.includes("强行确认合并") &&
        t.body.includes("已人工核实") &&
        t.body.includes("合并检查：排队中"),
    ),
  ).toBe(true);
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const state: CommandState = {
    ...s.state,
    assignments: [
      ...s.state.assignments,
      { ...base, scope: "standing", standing_mode: "office" },
    ],
  };
  const actor = {
    kind: "assignment" as const,
    project_id: human.project_id,
    assignment_id: base.id,
    ...role("pm"),
  };
  expect(recordDecision(state, actor, input, s.f.io)).toMatchObject({
    ok: false,
    error: {
      code: "forbidden_tool",
      message: "强行确认合并只能由人亲自操作，Agent 和 PM 不能代办",
    },
  });
  expect(recordDecision(s.state, s.f.actor(s.f.coder), input, s.f.io).ok).toBe(
    false,
  );
  expect(
    recordDecision(s.state, human, { ...input, option: "hold" }, s.f.io).ok,
  ).toBe(false);
  s.f.commit(s.confirm(s.state, s.q, "request_changes"));
  expect(answer("已人工核实").ok).toBe(false);
});

test("Q-458: trimmed code-point limits reject atomically and preserve the complete audited reason", async () => {
  const s = await setup();
  s.check("queued", "next");
  const before = JSON.stringify(s.state);
  for (const reason of [
    "",
    " \n\t ",
    "字".repeat(499),
    "字".repeat(500),
    "字".repeat(501),
    " 😀".repeat(250),
    ` \n${"😀".repeat(500)}\t `,
    "😀".repeat(501),
    "e\u0301".repeat(250),
    `${"e\u0301".repeat(250)}a`,
  ]) {
    const result = recordDecision(
      s.state,
      human,
      {
        decision_id: s.q.id,
        option: "merge",
        rationale: "人工决定",
        raw_quote: "确认",
        merge_override_reason: reason,
      },
      s.f.io,
    );
    const trimmed = reason.trim();
    const valid = trimmed.length > 0 && Array.from(trimmed).length <= 500;
    expect(result.ok).toBe(valid);
    expect(JSON.stringify(s.state)).toBe(before);
    if (result.ok) {
      const evidence = { reason: trimmed, blockers: ["合并检查：排队中"] };
      expect(result.value.data.resolution?.merge_override).toEqual(evidence);
      expect(result.value.events).toContainEqual(
        expect.objectContaining({
          type: "decision_resolved",
          payload: expect.objectContaining({ merge_override: evidence }),
        }),
      );
      expect(result.value.timeline.some((t) => t.body.includes(trimmed))).toBe(
        true,
      );
    } else {
      expect(result.error.code).toBe("validation_failed");
      if (trimmed)
        expect(result.error.message).toBe(
          "理由最多500个字符，请缩短后再提交。",
        );
    }
  }
});
