import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type Author,
  autoMergeSchedule,
  type CommandState,
  type Decision,
  listNeedsYou,
  type MergeDecisionEvidence,
  mergePlan,
  mergeRequiresHuman,
  pauseStandingAssignment,
  recordDecision,
  recordMergeCheck,
  releaseAssignment,
  requestDecision,
  resolveDelegatedDecision,
  setProjectPreferences,
  standingTools,
} from "../index.js";
import { mergeNeedsHuman, riskTagAutoMergeAllowed } from "./delegation.js";
import { humanDecidedMergeBasisValid } from "./human-decided-merge.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  assignment,
  human,
  id,
  machine,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const pm: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const summary = {
  changed: "按已批准方案修改",
  impact: "保持批准的行为",
  risk: "无",
};

async function setup(
  category: "scope_change" | "permission" = "scope_change",
  enabled?: boolean,
) {
  const state: CommandState = {
    project_settings: { merge_gate_enabled: true },
    project_id: human.project_id,
    machines: [machine()],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops],
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
  const f = mergeFixture("confirm", 3, { state, ports: ports() });
  if (enabled !== undefined)
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { pm_confirm_human_decided_merges: enabled },
        f.io,
      ),
    );
  const source = f.commit(
    requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        category,
        kind: "choose",
        question: "批准此改动？",
        context: "需求",
        options: [{ key: "yes", description: "批准", impact: "按此实施" }],
        recommended: "yes",
        affected_cards: [f.card.id],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: summary,
      },
      f.io,
    ),
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: source.id,
        option: "yes",
        rationale: "批准",
        raw_quote: "同意",
      },
      { ...f.io, human_confirmation: "workbench" },
    ),
  );
  const { product, completion } = await f.accept();
  const confirmation = () =>
    f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1) as Decision;
  const system: Actor = { kind: "system", project_id: human.project_id };
  const check = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "check",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  for (const status of ["queued", "running"] as const)
    f.commit(recordMergeCheck(f.state, system, { ...check, status }, f.io));
  f.commit(
    recordMergeCheck(
      f.state,
      system,
      {
        ...check,
        status: "passed",
        summary: "passed",
        log_ref: "check.log",
        checks: [
          { name: "unit", status: "passed", exit_code: 0, duration_ms: 1 },
        ],
      },
      f.io,
    ),
  );
  const evidence: MergeDecisionEvidence[] = [
    {
      decision_id: source.id,
      option: "yes",
      completion_id: completion.id,
      delivery_id: product.id,
      target_sha: product.subject.value,
      evidence: "src/feature.ts 按所选方案实现权限校验",
    },
  ];
  const answer = (
    entries: readonly MergeDecisionEvidence[] | null | undefined = evidence,
    snapshot = f.state,
  ) =>
    resolveDelegatedDecision(
      snapshot,
      pm,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "逐项核对一致",
        notice: "已核对人的批准与交付",
        ...(entries ? { decision_evidence: entries } : {}),
      },
      f.io,
    );
  return { f, source, product, completion, confirmation, evidence, answer };
}

test.each(["scope_change", "permission"] as const)(
  "human-decided %s defaults to PM with version-bound evidence",
  async (category) => {
    const { f, source, completion, confirmation, answer } =
      await setup(category);
    expect(confirmation().decider).toBe("role:pm");
    expect(mergeRequiresHuman(f.state, confirmation())).toBe(false);
    const queue = value(listNeedsYou(f.state, pm)).data.pm_queue;
    expect(queue?.merge_decision_evidence_required[confirmation().id]).toEqual([
      { decision_id: source.id, option: "yes" },
    ]);
    f.commit(answer());
    expect(
      confirmation().resolution?.human_decided_merge_basis?.entries[0],
    ).toMatchObject({ completion_id: completion.id, decision_id: source.id });
    expect(f.state.timeline.at(-1)?.body).toContain("拍板对应依据");
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  },
);

test("disabled preference preserves the exact existing human-only reason and rejects PM", async () => {
  const { f, source, confirmation, answer } = await setup(
    "scope_change",
    false,
  );
  expect(confirmation().decider).toBe("human");
  expect(
    mergeNeedsHuman(
      f.state.decisions,
      f.state.cards,
      f.card.id,
      f.state.project_preferences?.[0],
    ),
  ).toBe(`卡片涉及需求范围变化（${source.id}），合并须由人确认。`);
  expect(answer().ok).toBe(false);
});

test.each([
  "missing",
  "blank",
  "option",
  "completion",
  "delivery",
  "sha",
  "duplicate",
])("rejects %s evidence atomically", async (fault) => {
  const { f, evidence, answer } = await setup();
  const first = evidence[0] as MergeDecisionEvidence;
  const entries =
    fault === "missing"
      ? null
      : fault === "duplicate"
        ? [first, first]
        : [
            {
              ...first,
              ...(fault === "blank" ? { evidence: " " } : {}),
              ...(fault === "option" ? { option: "no" } : {}),
              ...(fault === "completion"
                ? { completion_id: id("delivery", 999) }
                : {}),
              ...(fault === "delivery"
                ? { delivery_id: id("delivery", 999) }
                : {}),
              ...(fault === "sha"
                ? { target_sha: first.target_sha.slice(0, 7) }
                : {}),
            },
          ];
  const before = JSON.stringify(f.state);
  expect(answer(entries).ok).toBe(false);
  expect(JSON.stringify(f.state)).toBe(before);
});

test.each(["open", "provisional", "delegated", "transcribed", "superseded"])(
  "%s source does not authorize a PM merge",
  async (fault) => {
    const { f, source, confirmation, answer } = await setup();
    const state: CommandState = {
      ...f.state,
      decisions: f.state.decisions.map((q) =>
        q.id !== source.id
          ? q
          : {
              ...q,
              ...(fault === "open" || fault === "provisional"
                ? { status: fault as Decision["status"] }
                : {}),
              ...(fault === "superseded"
                ? { superseded_by: id("decision", 999) }
                : {}),
              ...(q.resolution && fault === "delegated"
                ? {
                    resolution: {
                      ...q.resolution,
                      via: "delegated" as const,
                      resolved_by: `assignment:${ops.id}` as Author,
                    },
                  }
                : {}),
              ...(q.resolution && fault === "transcribed"
                ? {
                    resolution: {
                      ...q.resolution,
                      via: "pm_office_chat" as const,
                    },
                  }
                : {}),
            },
      ),
    };
    expect(mergeRequiresHuman(state, confirmation())).toBe(true);
    expect(answer(undefined, state).ok).toBe(false);
  },
);

test.each([
  "spending",
  "account",
  "data_deletion",
  "sensitive",
  "handoff",
  "review",
])("%s still blocks the exception", async (condition) => {
  const { f, source, confirmation, answer, evidence } = await setup();
  const state: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) =>
      condition === "sensitive"
        ? { ...c, sensitive: true }
        : condition === "review"
          ? { ...c, risk_tags: ["permission"] }
          : c,
    ),
    decisions:
      condition === "handoff"
        ? f.state.decisions.map((q) =>
            q.id === confirmation().id
              ? { ...q, human_required_reason: "对外发布或角色规则须交人" }
              : q,
          )
        : ["spending", "account", "data_deletion"].includes(condition)
          ? [
              ...f.state.decisions,
              {
                ...source,
                id: id("decision", 999),
                category: condition as "spending" | "account" | "data_deletion",
              },
            ]
          : f.state.decisions,
  };
  expect(answer(evidence, state).ok).toBe(false);
  expect(riskTagAutoMergeAllowed(state, confirmation())).toBe(false);
});

test.each([
  "option",
  "withdrawn",
  "revoked",
  "resolution",
  "sha",
  "preference",
  "new_question",
])("publication rechecks %s against the recorded basis", async (change) => {
  const { f, source, product, confirmation, answer } = await setup();
  f.commit(answer());
  const state: CommandState = {
    ...f.state,
    ...(change === "preference"
      ? {
          project_preferences: [
            {
              id: human.project_id,
              auto_merge_after_minutes: null,
              pm_confirm_human_decided_merges: false,
            },
          ],
        }
      : {}),
    deliveries: f.state.deliveries.map((v) =>
      change === "sha" && v.id === product.id
        ? { ...v, subject: { ...v.subject, value: "d".repeat(40) } }
        : v,
    ),
    decisions: [
      ...f.state.decisions.map((q) =>
        q.id !== source.id
          ? q
          : {
              ...q,
              ...(change === "withdrawn" || change === "revoked"
                ? { status: change as Decision["status"] }
                : {}),
              ...(q.resolution && change === "option"
                ? { resolution: { ...q.resolution, option: "no" } }
                : {}),
              ...(q.resolution && change === "resolution"
                ? {
                    resolution: { ...q.resolution, at: "2026-11-15T10:00:00Z" },
                  }
                : {}),
            },
      ),
      ...(change === "new_question"
        ? [{ ...source, id: id("decision", 999) }]
        : []),
    ],
  };
  expect(humanDecidedMergeBasisValid(state, confirmation())).toBe(false);
  expect(mergePlan(state, f.card.id).ok).toBe(false);
});

test("turning the preference off retires unpublished PM approval and re-enabling does not revive it", async () => {
  const { f, confirmation, answer } = await setup();
  f.commit(answer());
  const previous = confirmation();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_confirm_human_decided_merges: false },
      f.io,
    ),
  );
  expect(f.state.decisions.find((q) => q.id === previous.id)).toMatchObject({
    status: "superseded",
    resolution: previous.resolution,
  });
  expect(confirmation()).toMatchObject({ decider: "human", status: "open" });
  expect(confirmation().human_required_reason).toBeTruthy();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_confirm_human_decided_merges: true },
      f.io,
    ),
  );
  expect(confirmation().decider).toBe("human");
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
});

test("personal merge approval survives preference changes; agents cannot change the setting", async () => {
  const { f, confirmation } = await setup();
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "亲自确认",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  const before = confirmation();
  expect(
    setProjectPreferences(
      f.state,
      pm,
      { pm_confirm_human_decided_merges: false },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_confirm_human_decided_merges: false },
      f.io,
    ),
  );
  expect(confirmation()).toEqual(before);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("timeout cannot substitute for PM evidence even when the human has decided the scope", async () => {
  const { f, confirmation } = await setup();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: false, auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
});

test("project-level source decisions use the same formal answer and version binding", async () => {
  const { f, source, confirmation, answer, evidence } =
    await setup("permission");
  const state: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      source: { kind: "decision", decision_id: source.id },
    })),
    decisions: f.state.decisions.map((q) => {
      if (q.id !== source.id) return q;
      const { card_id: _card, ...projectDecision } = q;
      return { ...projectDecision, affected_cards: [] };
    }),
  };
  expect(mergeRequiresHuman(state, confirmation())).toBe(false);
  expect(answer(evidence, state).ok).toBe(true);
  const revoked: CommandState = {
    ...state,
    decisions: state.decisions.map((q) =>
      q.id === source.id ? { ...q, status: "withdrawn" } : q,
    ),
  };
  expect(mergeRequiresHuman(revoked, confirmation())).toBe(true);
  expect(answer(evidence, revoked).ok).toBe(false);
});

test("every decision and every current product needs its own mapping", async () => {
  const { f, source, product, evidence, answer } = await setup();
  const original = f.state.decisions.find(
    (q) => q.id === source.id,
  ) as Decision;
  const otherDecision = { ...original, id: id("decision", 999) };
  const originalItem = f.state.work_items.find(
    (w) => w.id === product.work_item_id,
  );
  if (originalItem?.kind !== "produce") throw new Error("Missing product");
  const otherItem = {
    ...originalItem,
    id: id("work_item", 999),
    required: false,
  };
  const acceptedProduct = f.state.deliveries.find((v) => v.id === product.id);
  if (!acceptedProduct) throw new Error("Missing delivery");
  const otherProduct = {
    ...acceptedProduct,
    id: id("delivery", 999),
    work_item_id: otherItem.id,
    subject: { kind: "git_head" as const, value: "e".repeat(40) },
  };
  const state: CommandState = {
    ...f.state,
    decisions: [...f.state.decisions, otherDecision],
    work_items: [...f.state.work_items, otherItem],
    deliveries: [...f.state.deliveries, otherProduct],
  };
  const first = evidence[0] as MergeDecisionEvidence;
  const entries = [original, otherDecision].flatMap((q) =>
    [acceptedProduct, otherProduct].map((v) => ({
      ...first,
      decision_id: q.id,
      delivery_id: v.id,
      target_sha: v.subject.value,
    })),
  );
  expect(answer(evidence, state).ok).toBe(false);
  expect(answer(entries.slice(1), state).ok).toBe(false);
  expect(answer(entries, state).ok).toBe(true);
});

test("no active PM and a new completion cannot reuse a previous evidence record", async () => {
  const { f, answer, confirmation, completion } = await setup();
  f.commit(answer());
  expect(
    mergePlan(
      {
        ...f.state,
        assignments: f.state.assignments.filter((a) => a.id !== ops.id),
      },
      f.card.id,
    ).ok,
  ).toBe(false);
  const current = f.state.deliveries.find((v) => v.id === completion.id);
  if (!current) throw new Error("Missing completion");
  const changed: CommandState = {
    ...f.state,
    deliveries: f.state.deliveries
      .map((v) =>
        v.id === completion.id ? { ...v, status: "superseded" as const } : v,
      )
      .concat({ ...current, id: id("delivery", 999) }),
  };
  expect(humanDecidedMergeBasisValid(changed, confirmation())).toBe(false);
  expect(mergePlan(changed, f.card.id).ok).toBe(false);
});

test.each(["pause", "release"] as const)(
  "%s of PM Ops retires an unpublished human-decided merge authorization",
  async (action) => {
    const { f, answer, confirmation } = await setup();
    f.commit(answer());
    const previous = confirmation();
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    const params = { assignment_id: ops.id };
    if (action === "pause")
      f.commit(pauseStandingAssignment(f.state, human, params, f.io));
    else f.commit(releaseAssignment(f.state, human, params, f.io));
    expect(f.state.decisions.find((q) => q.id === previous.id)).toMatchObject({
      status: "superseded",
      resolution: previous.resolution,
    });
    expect(confirmation()).toMatchObject({
      status: "open",
      decider: "human",
      human_required_reason: expect.any(String),
    });
    expect(confirmation().id).not.toBe(previous.id);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  },
);
