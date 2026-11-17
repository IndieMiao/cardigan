import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandState,
  confirmSourceMergeUnrelated,
  type Decision,
  mergePlan,
  mergeRequiresHuman,
  recordDecision,
  recordMergeCheck,
  recordMergeResult,
  requestDecision,
  resolveDelegatedDecision,
  setProjectPreferences,
  sourceMergeSuggestionView,
} from "../index.js";
import { mergeNeedsHuman } from "./delegation.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { systemMergeHumanReason } from "./system-merge-policy.js";
import { apply, assignment, human, id, role, value } from "./test-fixtures.js";

function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("Missing fixture value");
  return v;
}

async function setup() {
  const f = mergeFixture();
  await f.accept();
  const source = f.commit(
    requestDecision(
      f.state,
      human,
      {
        category: "credential",
        kind: "choose",
        question: "Rotate external account?",
        context: "An earlier business decision",
        options: [{ key: "yes", description: "轮换", impact: "旧账号停用" }],
        recommended: "yes",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: {
          changed: "轮换账号",
          impact: "旧账号停用",
          risk: "涉及账号",
        },
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
        raw_quote: "同意",
        rationale: "同意",
      },
      f.io,
    ),
  );
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  const actor: Actor = {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: ops.id,
    ...role("pm"),
  };
  // Synthetic source attachment models a card originally created from this decision.
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        {
          collection: "cards",
          entity: {
            ...required(f.state.cards[0]),
            source: { kind: "decision", decision_id: source.id },
          },
        },
        { collection: "assignments", entity: ops },
      ],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  const q = () =>
    required(
      f.state.decisions.findLast((q) => q.trigger === "merge_confirmation"),
    );
  const propose = () =>
    f.commit(
      resolveDelegatedDecision(
        f.state,
        actor,
        {
          decision_id: q().id,
          option: "merge",
          rationale: "复核来源",
          escalate: true,
          source_unrelated: {
            decision_id: source.id,
            rationale: "本卡只调整标签，不使用此账号",
          },
        },
        f.io,
      ),
    );
  const params = () => ({
    decision_id: q().id,
    card_id: f.card.id,
    source_decision_id: source.id,
    version: required(q().source_unrelated_suggestion).version,
  });
  const confirm = (state = f.state, who = human) =>
    confirmSourceMergeUnrelated(state, who, params(), {
      ...f.io,
      human_confirmation: "workbench",
    });
  return { f, q, source, actor, propose, params, confirm };
}

test("C-311: only human consent removes a source reason, never resolves the merge or business decision", async () => {
  const { f, q, source, actor, propose, confirm } = await setup();
  expect(mergeRequiresHuman(f.state, q())).toBe(true);
  propose();
  expect(mergeRequiresHuman(f.state, q())).toBe(true);
  expect(confirm(f.state, actor).ok).toBe(false);
  const effect = value(confirm());
  expect(
    effect.events.find((e) => e.type === "source_merge_unrelated_confirmed"),
  ).toMatchObject({
    actor: human,
    card_id: f.card.id,
    payload: {
      source_decision_id: source.id,
      rationale: "本卡只调整标签，不使用此账号",
      confirmed_by: "human",
    },
  });
  f.commit({ ok: true, value: effect });
  expect(mergeRequiresHuman(f.state, q())).toBe(false);
  expect(q().status).toBe("open");
  expect(q().resolution).toBeUndefined();
  expect(q().decider).toBe("role:pm");
  expect(
    f.state.decisions.find((s) => s.id === source.id)?.resolution?.option,
  ).toBe("yes");
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(value(confirm()).events).toEqual([]);
  expect(sourceMergeSuggestionView(f.state, q())).toMatchObject({
    confirmed: { by: "human" },
  });
});

test("C-311: missing/forged/cross-card/cross-project consent and legacy labels never lift the source", async () => {
  const { f, q, source, actor, propose, confirm } = await setup();
  propose();
  f.commit(confirm());
  const audit = required(
    f.state.events.find((e) => e.type === "source_merge_unrelated_confirmed"),
  );
  for (const replace of [
    undefined,
    { ...audit, actor },
    { ...audit, card_id: id("card", 99) },
    {
      ...audit,
      actor: { ...human, project_id: "other" as typeof human.project_id },
    },
    { ...audit, payload: { source_decision_id: source.id } },
  ]) {
    const state = {
      ...f.state,
      events: f.state.events
        .filter((e) => e.id !== audit.id)
        .concat(replace ? [replace] : []),
    };
    expect(mergeRequiresHuman(state, q())).toBe(true);
  }
  const card = { ...required(f.state.cards[0]), id: id("card", 99) };
  expect(
    mergeNeedsHuman(
      f.state.decisions,
      [card],
      card.id,
      undefined,
      f.state.events,
    ),
  ).toContain(source.id);
  const legacy = {
    ...f.state,
    events: [],
    decisions: f.state.decisions.map((s) =>
      s.id === source.id
        ? { ...s, raised_by: "human" as const, merge_related: false as const }
        : s,
    ),
  };
  expect(mergeRequiresHuman(legacy, q())).toBe(true);
});

test("C-311: stale versions, changed sources and withdrawn completion reject without effects", async () => {
  const { f, q, source, propose, params, confirm } = await setup();
  propose();
  const old = params();
  propose();
  expect(
    confirmSourceMergeUnrelated(f.state, human, old, {
      ...f.io,
      human_confirmation: "workbench",
    }).ok,
  ).toBe(false);
  for (const changed of [
    {
      ...f.state,
      cards: f.state.cards.map((c) => ({
        ...c,
        source: { kind: "quote" as const, text: "changed" },
      })),
    },
    {
      ...f.state,
      decisions: f.state.decisions.map((s) =>
        s.id === source.id ? { ...s, status: "withdrawn" as const } : s,
      ),
    },
    {
      ...f.state,
      decisions: f.state.decisions.map((s) =>
        s.id === source.id ? { ...s, context: "new meaning" } : s,
      ),
    },
    {
      ...f.state,
      deliveries: f.state.deliveries.map((v) =>
        v.kind === "card_completion"
          ? { ...v, status: "superseded" as const }
          : v,
      ),
    },
  ]) {
    expect(sourceMergeSuggestionView(changed, q())?.stale).toBe(true);
    expect(confirm(changed).ok).toBe(false);
  }
  expect(
    confirmSourceMergeUnrelated(
      f.state,
      human,
      { ...params(), card_id: id("card", 99) },
      { ...f.io, human_confirmation: "workbench" },
    ).ok,
  ).toBe(false);
});

test("C-311: other reasons and current category grants remain authoritative", async () => {
  const { f, q, source, propose, confirm } = await setup();
  propose();
  f.commit(confirm());
  for (const category of [
    "spending",
    "account",
    "credential",
    "data_deletion",
    "publish",
  ] as const) {
    const other: Decision = {
      ...source,
      id: id("decision", 999),
      category,
      card_id: f.card.id,
    };
    const state: CommandState = {
      ...f.state,
      decisions: [...f.state.decisions, other],
    };
    expect(mergeRequiresHuman(state, q())).toBe(true);
    expect(systemMergeHumanReason(state, q())).toContain(other.id);
    const granted = value(
      setProjectPreferences(
        state,
        human,
        { decision_delegation: { [category]: true } },
        f.io,
      ),
    );
    const authorized = apply(state, granted);
    expect(mergeRequiresHuman(authorized, q())).toBe(false);
    expect(
      mergeRequiresHuman(
        {
          ...authorized,
          events: authorized.events.filter((e) => !granted.events.includes(e)),
        },
        q(),
      ),
    ).toBe(true);
  }
  const sensitive = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, sensitive: true })),
  };
  expect(mergeRequiresHuman(sensitive, q())).toBe(true);
  expect(systemMergeHumanReason(sensitive, q())).toContain("敏感");
});

test("C-311: consent is rechecked for publication and never revives after source revisions", async () => {
  const { f, q, source, propose, confirm } = await setup();
  propose();
  f.commit(confirm());
  const passed = f.state;
  // Publish consumer must reject a proxy authorization once the source changes.
  const changed = {
    ...passed,
    decisions: passed.decisions.map((s) =>
      s.id === source.id ? { ...s, context: "changed" } : s,
    ),
  };
  expect(mergeRequiresHuman(changed, q())).toBe(true);
  expect(systemMergeHumanReason(changed, q())).toContain(source.id);
  const revision = {
    ...required(passed.events[0]),
    id: f.io.ids.nextEventId(),
    type: "card_updated",
    card_id: f.card.id,
  };
  const restored = { ...passed, events: [...passed.events, revision] };
  expect(mergeRequiresHuman(restored, q())).toBe(true);
});

test("C-311: a separately approved PM merge publishes only while the source consent stays valid", async () => {
  const { f, q, source, actor, propose, confirm } = await setup();
  const completion = required(
    f.state.deliveries.find((v) => v.kind === "card_completion"),
  );
  const system: Actor = { kind: "system", project_id: f.state.project_id };
  for (const status of ["queued", "running", "passed"] as const)
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        {
          card_id: f.card.id,
          completion_id: completion.id,
          attempt_id: "source-check",
          candidate_sha: "b".repeat(40),
          tree_sha: "c".repeat(40),
          ...(status === "passed"
            ? {
                status,
                checks: [
                  {
                    name: "test",
                    status: "passed" as const,
                    exit_code: 0,
                    duration_ms: 1,
                  },
                ],
                summary: "Passed",
                log_ref: "source-check.log",
              }
            : { status }),
        },
        f.io,
      ),
    );
  propose();
  f.commit(confirm());
  f.commit(
    resolveDelegatedDecision(
      f.state,
      actor,
      {
        decision_id: q().id,
        option: "merge",
        rationale: "全部检查已通过",
        notice: "仅标签改动，已核对",
      },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  const changed = {
    ...f.state,
    decisions: f.state.decisions.map((s) =>
      s.id === source.id ? { ...s, context: "different account use" } : s,
    ),
  };
  expect(mergePlan(changed, f.card.id).ok).toBe(false);
  expect(
    recordMergeResult(
      changed,
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          merge_sha: "b".repeat(40),
          previous_sha: "d".repeat(40),
          tree_sha: "c".repeat(40),
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
});
