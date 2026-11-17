import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  listNeedsYou,
  type RequestDecisionParams,
  recordDecision,
  requestDecision,
  resolveDelegatedDecision,
  setProjectPreferences,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const reason = "访问真实凭据，须由人决定";
const params: RequestDecisionParams = {
  card_id: id("card", 1),
  category: "credential",
  kind: "choose",
  question: "是否调整上限？",
  context: "已列明影响",
  options: [{ key: "go", description: "调整", impact: "改变行为" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  plain_summary: {
    changed: "调整处理上限",
    impact: "改变处理方式",
    risk: "无",
  },
};
function setup() {
  const state = fixture();
  const { work_item_id: _work, ...base } = assignment(5, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  return {
    state: { ...state, assignments: [...state.assignments, ops] },
    io: ports(),
  };
}

test.each(["coder", "office", "ops", "human"])(
  "C-304: %s cannot weaken an explicit human-only decision",
  (raiser) => {
    const f = setup();
    const author =
      raiser === "human"
        ? human
        : raiser === "coder"
          ? actor()
          : actor(raiser === "office" ? 4 : 5, "pm");
    const requested = value(
      requestDecision(
        f.state,
        author,
        { ...params, human_required_reason: ` ${reason} ` },
        f.io,
      ),
    );
    const q = requested.data;
    expect(q).toMatchObject({
      decider: raiser === "coder" ? "role:pm" : "human",
      human_required_reason: reason,
    });
    expect(q.delegation_authority).toBeUndefined();
    let state = apply(f.state, requested);
    if (raiser === "coder")
      expect(value(listNeedsYou(state, human)).data.decisions).toHaveLength(0);
    else
      expect(value(listNeedsYou(state, human)).data.decisions).toContainEqual(
        expect.objectContaining({ id: q.id, human_required_reason: reason }),
      );
    // Re-enabling the category never reclaims a pinned question or clears its reason.
    state = apply(
      state,
      value(
        setProjectPreferences(
          state,
          human,
          { decision_delegation: { general: false } },
          f.io,
        ),
      ),
    );
    state = apply(
      state,
      value(
        setProjectPreferences(
          state,
          human,
          { decision_delegation: { general: true } },
          f.io,
        ),
      ),
    );
    const answer = {
      decision_id: q.id,
      option: "go",
      rationale: "按授权处理",
      raw_quote: "同意",
    };
    for (const spoof of [
      {},
      { human_required_reason: "" },
      { human_required_reason: undefined, actor: human },
    ]) {
      expect(
        resolveDelegatedDecision(
          state,
          actor(5, "pm"),
          { ...answer, ...spoof },
          f.io,
        ),
      ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
      expect(
        recordDecision(state, actor(4, "pm"), { ...answer, ...spoof }, f.io),
      ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
    }
    expect(state.decisions.find((d) => d.id === q.id)).toMatchObject({
      status: "open",
      human_required_reason: reason,
      decider: raiser === "coder" ? "role:pm" : "human",
    });
    expect(
      value(recordDecision(state, human, answer, f.io)).data,
    ).toMatchObject({ status: "resolved", human_required_reason: reason });
  },
);

test("C-304: delegated responses and events explain routing without changing persisted decisions", () => {
  const f = setup();
  for (const explicit of [false, true]) {
    const disabled = apply(
      f.state,
      value(
        setProjectPreferences(
          f.state,
          human,
          { decision_delegation: { general: false } },
          f.io,
        ),
      ),
    );
    const state = explicit
      ? apply(
          disabled,
          value(
            setProjectPreferences(
              disabled,
              human,
              { decision_delegation: { general: true } },
              f.io,
            ),
          ),
        )
      : f.state;
    const effect = value(
      requestDecision(state, actor(), { ...params, category: "general" }, f.io),
    );
    const authority = effect.data.delegation_authority;
    expect(authority).toContain(
      explicit
        ? "/decision_delegation/general"
        : "/default-decision-delegation/general",
    );
    expect(effect.data).toMatchObject({
      decider: "role:pm",
      routed_to: "role:pm",
      routing_reason: authority,
    });
    expect(effect.events[0]?.payload).toMatchObject({
      routed_to: "role:pm",
      routing_reason: authority,
    });
    expect(effect.timeline[0]?.body).toBe(
      `${params.question}\n已进入 PM 待办，尚未授权处理或交人`,
    );
    const {
      routed_to: _to,
      routing_reason: _reason,
      ...decision
    } = effect.data;
    expect(apply(state, effect).decisions).toContainEqual(decision);
  }
});

test("C-304: reason validates input and preserves scope and machine identity boundaries", () => {
  const f = setup();
  for (const human_required_reason of ["", " \n", null, 123])
    expect(
      requestDecision(
        f.state,
        actor(),
        {
          ...params,
          category: "general" as const,
          human_required_reason,
        } as RequestDecisionParams,
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  for (const decider of ["role:pm", "role:reviewer"] as const)
    expect(
      requestDecision(
        f.state,
        actor(),
        {
          ...params,
          category: "general" as const,
          decider,
          human_required_reason: reason,
        },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const forced = {
    ...params,
    category: "general" as const,
    human_required_reason: reason,
  };
  for (const extra of [
    { card_id: id("card", 2) },
    { affected_cards: [id("card", 2)] },
    { affected_work_items: [id("work_item", 5)] },
  ])
    expect(
      requestDecision(f.state, actor(), { ...forced, ...extra }, f.io).ok,
    ).toBe(false);
  const { card_id: _card, ...projectWide } = forced;
  expect(requestDecision(f.state, actor(), projectWide, f.io).ok).toBe(false);
  for (const identity of [
    { ...actor(), project_id: "another-project" },
    { kind: "system", project_id: human.project_id },
  ] as Actor[])
    expect(requestDecision(f.state, identity, forced, f.io).ok).toBe(false);
  const { plain_summary: _summary, ...withoutSummary } = forced;
  expect(requestDecision(f.state, actor(), withoutSummary, f.io).ok).toBe(
    false,
  );
  expect(f.state.decisions).toEqual([]);
  expect(f.state.events).toEqual([]);
});

test.each(["general", "permission", "scope_change"] as const)(
  "Flow Lite: a general human-required note does not force %s to a person; Ops settles with notice and a human can take over",
  (category) => {
    const f = setup();
    const requested = value(
      requestDecision(
        f.state,
        actor(),
        { ...params, category, human_required_reason: "请核对一般规则" },
        f.io,
      ),
    );
    const waiting = apply(f.state, requested);
    expect(requested.data).toMatchObject({
      decider: "role:pm",
      human_required_reason: "请核对一般规则",
    });
    const resolved = value(
      resolveDelegatedDecision(
        waiting,
        actor(5, "pm"),
        {
          decision_id: requested.data.id,
          option: "go",
          rationale: "Reviewed the current scope",
        },
        f.io,
      ),
    );
    expect(resolved.data).toMatchObject({
      status: "resolved",
      resolution: { via: "delegated", option: "go" },
    });
    expect(
      resolved.events.find((e) => e.type === "decision_resolved")?.payload,
    ).toMatchObject({ via: "delegated" });
    const humanResult = value(
      recordDecision(
        waiting,
        human,
        {
          decision_id: requested.data.id,
          option: "go",
          rationale: "Human takeover",
          raw_quote: "Approved",
        },
        { ...f.io, human_confirmation: "workbench" },
      ),
    );
    expect(humanResult.data).toMatchObject({
      decider: "human",
      status: "resolved",
      resolution: { resolved_by: "human", via: "needs_you" },
    });
  },
);
