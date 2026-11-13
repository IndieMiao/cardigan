import { expect, test } from "vitest";
import type { Decision, Delivery } from "../entities.js";
import {
  type Actor,
  type Assignment,
  buildPlainSummary,
  type CommandState,
  PLAIN_SUMMARY_LIMITS,
  pauseStandingAssignment,
  plainSummaryJargon,
  plainSummaryNoRisk,
  prepareDelivery,
  type RequestDecisionParams,
  requestDecision,
  resolveDelegatedDecision,
  standingTools,
  submitDelivery,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  apply,
  assignment,
  human,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const PLAIN = {
  changed:
    "开了截图核对开关后，界面卡的截图核对只能由二郎神给结论，PM 只有在它通过时才能代确认合并",
  impact: "开关默认关着，现在行为不变",
  risk: "改了 pm 和独立复核员的角色规则",
};
const REWRITE = {
  changed: "合并前要多看一眼截图",
  impact: "界面卡合并会慢一点",
  risk: "无",
};

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const office: Assignment = {
  ...base,
  id: "A-901" as Assignment["id"],
  scope: "standing",
  standing_mode: "office",
};
const standing = (a: Assignment, mode: "ops" | "office"): Actor => ({
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: a.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, mode),
});
const opsActor = standing(ops, "ops");
const officeActor = standing(office, "office");

async function setup(accepted = true) {
  const empty: CommandState = {
    project_id: human.project_id,
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops, office],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  const f = mergeFixture("confirm", 3, { state: empty, ports: ports() });
  if (accepted) await f.accept();
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  const escalate = (extra: object = {}, state = f.state) =>
    resolveDelegatedDecision(
      state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "界面卡，需要人看一眼",
        escalate: true,
        ...extra,
      } as Parameters<typeof resolveDelegatedDecision>[2],
      f.io,
    );
  return { f, confirmation, escalate };
}

const ask = (
  card_id: RequestDecisionParams["card_id"],
  extra: Partial<RequestDecisionParams> = {},
): RequestDecisionParams => ({
  ...(card_id ? { card_id } : {}),
  category: "general",
  kind: "choose",
  question: "用哪种布局？",
  context: "两种都能用，细节见交付",
  options: [
    { key: "a", description: "左侧", impact: "保持宽度" },
    { key: "b", description: "右侧", impact: "更宽" },
  ],
  recommended: "a",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  ...extra,
});

// ---- validation rules -------------------------------------------------------

/** The plain-language rejection message, or undefined when accepted. */
const rejection = (input: unknown): string | undefined => {
  try {
    buildPlainSummary(input);
    return undefined;
  } catch (e) {
    return (e as { error: { code: string; message: string } }).error.message;
  }
};

test("C-202: the Q-337 example passes and is trimmed; 无 means no risk", () => {
  expect(
    buildPlainSummary({
      changed: `  ${PLAIN.changed} `,
      impact: PLAIN.impact,
      risk: PLAIN.risk,
    }),
  ).toEqual(PLAIN);
  expect(plainSummaryNoRisk(PLAIN)).toBe(false);
  expect(plainSummaryNoRisk({ ...PLAIN, risk: "无" })).toBe(true);
  expect(plainSummaryNoRisk({ ...PLAIN, risk: "无。" })).toBe(true);
  expect(plainSummaryNoRisk({ ...PLAIN, risk: "无风险但要留意" })).toBe(false);
});

test.each([
  ["missing object", undefined, "缺少"],
  ["array", [], "缺少"],
  ["missing changed", { impact: "x", risk: "无" }, "改了什么"],
  ["blank impact", { changed: "x", impact: "  ", risk: "无" }, "对你的影响"],
  ["missing risk", { changed: "x", impact: "y" }, "没有风险就写“无”"],
  ["non-string risk", { changed: "x", impact: "y", risk: 0 }, "风险"],
  [
    "unknown key",
    { changed: "x", impact: "y", risk: "无", extra: "z" },
    "extra",
  ],
])("C-202: %s is rejected in plain words", (_name, input, phrase) => {
  expect(rejection(input)).toContain(phrase);
});

test.each(Object.entries(PLAIN_SUMMARY_LIMITS))(
  "C-202: %s is accepted at exactly its limit and rejected one past it",
  (key, limit) => {
    const at = { ...REWRITE, [key]: "字".repeat(limit) };
    expect(buildPlainSummary(at)).toEqual(at);
    // Code points, not UTF-16 units: an astral character counts once.
    const astral = { ...REWRITE, [key]: "𠀋".repeat(limit) };
    expect(buildPlainSummary(astral)).toEqual(astral);
    expect(rejection({ ...REWRITE, [key]: "字".repeat(limit + 1) })).toContain(
      `最多 ${limit} 个字`,
    );
  },
);

test.each([
  ["delivery", "按 D-684 改了布局"],
  ["review", "审核 V-658 提的问题已修"],
  ["work item", "W-604 已完成"],
  ["decision", "和 Q-337 一样"],
  ["run", "R-3084 跑完了"],
  ["assignment", "交给 A-577"],
  ["human action", "H-12 已经做了"],
  ["legacy decision", "见 q(12)"],
  ["commit", "提交 acc700fa 改了开关"],
  ["full commit", `基于 ${"a1".repeat(20)}`],
  ["backtick", "改了 `merge` 的行为"],
  ["snake_case interface", "改了 submit_delivery 的参数"],
  ["english enum", "风险标签 numeric_rule"],
  ["camelCase interface", "调整 requestDecision 的校验"],
  ["key=value", "decider=human 时必填"],
])("C-202: a %s reference is rejected", (_kind, text) => {
  expect(plainSummaryJargon(text)).toBeDefined();
  for (const key of ["changed", "impact", "risk"])
    expect(rejection({ ...REWRITE, [key]: text })).toContain(
      "请改用人能看懂的白话",
    );
});

test.each([
  "和 C-192 一起做的建议按钮",
  "Workbench 的 Needs You 列表",
  "窄屏 390px 和暗色都看过",
  "改了 pm 和独立复核员的角色规则",
  "PR-12 里的说明",
  "2026 年 11 月起生效",
  "macOS 上也能用",
])("C-202: plain text %s is allowed", (text) => {
  expect(plainSummaryJargon(text)).toBeUndefined();
});

// ---- request_decision -----------------------------------------------------

test("C-202: request_decision for the human rejects a missing or jargon summary without any write", async () => {
  const { f } = await setup();
  const before = JSON.stringify(f.state);
  for (const plain_summary of [
    undefined,
    { ...PLAIN, changed: "按 D-684 改" },
    { ...PLAIN, risk: "" },
  ]) {
    const r = requestDecision(
      f.state,
      officeActor,
      ask(f.card.id, plain_summary ? { plain_summary } : {}),
      f.io,
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  }
  expect(JSON.stringify(f.state)).toBe(before);
  const q = f.commit(
    requestDecision(
      f.state,
      officeActor,
      ask(f.card.id, { plain_summary: PLAIN }),
      f.io,
    ),
  );
  expect(q.plain_summary).toEqual(PLAIN);
});

test("C-202: the human raising a decision for themself must write it too", async () => {
  const { f } = await setup();
  expect(requestDecision(f.state, human, ask(f.card.id), f.io)).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
});

test("C-202: a decision for a role needs no summary, but a given one is validated and kept", async () => {
  const { f } = await setup();
  const q = f.commit(
    requestDecision(
      f.state,
      officeActor,
      ask(f.card.id, { decider: "role:reviewer" }),
      f.io,
    ),
  );
  expect(q).not.toHaveProperty("plain_summary");
  expect(
    requestDecision(
      f.state,
      officeActor,
      ask(f.card.id, {
        decider: "role:reviewer",
        plain_summary: { ...PLAIN, impact: "`x`" },
      }),
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

// ---- completion request → merge confirmation ------------------------------

test("C-202: a completion request without a plain change note is rejected; other deliveries cannot carry one", async () => {
  const { f } = await setup(false);
  const product = await f.deliver("code");
  const reviewed = f.state;
  f.start(f.coder);
  const base = {
    work_item_id: f.coder.work_item_id as Delivery["work_item_id"],
    summary: "Ready",
    known_gaps: [],
    subject: { kind: "git_head" as const, value: product.subject.value },
  };
  for (const [kind, plain_summary, phrase] of [
    ["card_completion", undefined, "缺少完成申请的人话改动说明"],
    ["card_completion", { ...PLAIN, changed: "修了 V-658" }, "内部编号"],
    ["code", PLAIN, "只在完成申请"],
  ] as const) {
    const p = {
      ...base,
      kind,
      requested_verifiers:
        kind === "card_completion"
          ? [f.pm.work_item_id as Delivery["work_item_id"]]
          : [],
      ...(plain_summary ? { plain_summary } : {}),
    };
    const prepared = await prepareDelivery(reviewed, f.actor(f.coder), p, {
      verify: async () => ({ ok: true, value: [] }),
    });
    const result = prepared.ok
      ? submitDelivery(reviewed, f.actor(f.coder), p, prepared.value, f.io)
      : prepared;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    if (!result.ok) expect(result.error.message).toContain(phrase);
  }
});

test("C-202: the system merge confirmation carries the completion's plain change note", async () => {
  const { f, confirmation } = await setup();
  const completion = f.state.deliveries.find(
    (d) => d.kind === "card_completion",
  );
  expect(completion?.plain_summary).toBeDefined();
  expect(confirmation().plain_summary).toEqual(completion?.plain_summary);
});

// ---- escalation and PM rewrite --------------------------------------------

const handoff = (state: CommandState, q: Decision) =>
  state.events.filter(
    (e) =>
      e.type === "decision_requested" &&
      (e.payload as { decision_id?: string }).decision_id === q.id &&
      (e.payload as { previous_decider?: string }).previous_decider,
  );

test("C-202: escalating keeps the completion's summary without a rewrite record", async () => {
  const { f, confirmation, escalate } = await setup();
  expect(confirmation().decider).toBe("role:pm");
  const original = confirmation().plain_summary;
  f.commit(escalate());
  expect(confirmation()).toMatchObject({
    decider: "human",
    plain_summary: original,
  });
  const [event] = handoff(f.state, confirmation());
  expect(event?.payload).not.toHaveProperty("plain_summary_rewrite");
  // Resending the same text is no rewrite either.
});

test("C-202: a PM rewrite on escalation is applied and audited with the actor from the token", async () => {
  const { f, confirmation, escalate } = await setup();
  const original = confirmation().plain_summary;
  f.commit(escalate({ plain_summary: REWRITE }));
  expect(confirmation().plain_summary).toEqual(REWRITE);
  const [event] = handoff(f.state, confirmation());
  expect(event?.actor).toMatchObject({ assignment_id: ops.id });
  expect(event?.payload).toMatchObject({
    plain_summary_rewrite: {
      previous: original,
      next: REWRITE,
      by: `assignment:${ops.id}`,
    },
  });
  expect(
    f.state.timeline.some(
      (t) =>
        t.decision_id === confirmation().id &&
        t.body.includes("项目经理改写了人话概述"),
    ),
  ).toBe(true);
});

test("C-202: a rewrite cannot smuggle its own audit fields", async () => {
  const { f, escalate } = await setup();
  expect(
    escalate({
      plain_summary: { ...REWRITE, by: "human", previous: null },
    }),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(f.state.events.some((e) => e.type === "decision_requested")).toBe(
    true,
  );
});

test("C-202: an older confirmation without a summary must get one when PM escalates it", async () => {
  const { f, confirmation, escalate } = await setup();
  // A confirmation opened before C-202, from a completion without the note.
  const { plain_summary: _gone, ...legacy } = confirmation();
  const state: CommandState = {
    ...f.state,
    decisions: f.state.decisions.map((q) => (q.id === legacy.id ? legacy : q)),
  };
  const missing = escalate({}, state);
  expect(missing).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  if (!missing.ok) expect(missing.error.message).toContain("人话概述");
  expect(
    escalate(
      { plain_summary: { ...REWRITE, changed: "提交 acc700fa" } },
      state,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const ok = escalate({ plain_summary: REWRITE }, state);
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;
  const event = ok.value.events.find((e) => e.type === "decision_requested");
  expect(event?.payload).toMatchObject({
    plain_summary_rewrite: { previous: null, next: REWRITE },
  });
});

test("C-202: plain_summary is refused when PM decides instead of escalating", async () => {
  const { f, confirmation } = await setup();
  const before = JSON.stringify(f.state);
  expect(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "hold",
        rationale: "先等等",
        plain_summary: REWRITE,
      } as Parameters<typeof resolveDelegatedDecision>[2],
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(JSON.stringify(f.state)).toBe(before);
});

test("C-202: a project decision escalated by PM without any summary is rejected", async () => {
  const { f } = await setup();
  const q = f.commit(
    requestDecision(
      f.state,
      officeActor,
      ask(undefined, { decider: "role:pm", category: "general" }),
      f.io,
    ),
  );
  const call = (extra: object) =>
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: q.id,
        option: "a",
        rationale: "人来定",
        escalate: true,
        ...extra,
      } as Parameters<typeof resolveDelegatedDecision>[2],
      f.io,
    );
  expect(call({})).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  const escalated = value(call({ plain_summary: REWRITE }));
  expect(escalated.data).toMatchObject({
    decider: "human",
    plain_summary: REWRITE,
  });
});

test("C-202: the system still hands an older confirmation without a summary to the human", async () => {
  const { f, confirmation } = await setup();
  const { plain_summary: _gone, ...legacy } = confirmation();
  const state: CommandState = {
    ...f.state,
    decisions: f.state.decisions.map((q) => (q.id === legacy.id ? legacy : q)),
  };
  const paused = apply(
    state,
    value(
      pauseStandingAssignment(state, human, { assignment_id: ops.id }, f.io),
    ),
  );
  const q = paused.decisions.find((x) => x.id === legacy.id);
  expect(q).toMatchObject({ decider: "human", status: "open" });
  expect(q).not.toHaveProperty("plain_summary");
});
