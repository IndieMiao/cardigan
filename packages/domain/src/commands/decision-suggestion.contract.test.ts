import { expect, test } from "vitest";
import type { Event } from "../entities.js";
import {
  type Actor,
  type Assignment,
  type CommandState,
  decisionActionView,
  type RequestDecisionParams,
  recordDecision,
  requestDecision,
  resolveDelegatedDecision,
  standingTools,
  suggestionStale,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { assignment, human, ports, role } from "./test-fixtures.js";

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

async function setup() {
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
  await f.accept();
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  const escalate = (suggestion?: object, extra: object = {}) =>
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "界面卡，需要人看一眼",
        escalate: true,
        ...(suggestion ? { suggestion } : {}),
        ...extra,
      } as Parameters<typeof resolveDelegatedDecision>[2],
      f.io,
    );
  const apply = (actor: Actor, p: object, state = f.state) =>
    recordDecision(
      state,
      actor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "",
        raw_quote: "",
        via_suggestion: true,
        ...p,
      },
      f.io,
    );
  return { f, confirmation, escalate, apply };
}

test("C-192: without a suggestion the decision and its view keep their previous shape", async () => {
  const { f, confirmation, escalate } = await setup();
  f.commit(escalate());
  const q = confirmation();
  expect(q.decider).toBe("human");
  expect(q).not.toHaveProperty("suggestion");
  expect(decisionActionView(f.state, q)).not.toHaveProperty("suggestion");
});

test("C-192: escalating with a suggestion records option, reason and author; the view is fresh", async () => {
  const { f, confirmation, escalate } = await setup();
  f.commit(escalate({ option: "merge", rationale: "检查和审核都通过" }));
  const q = confirmation();
  expect(q).toMatchObject({
    decider: "human",
    recommended: "merge",
    suggestion: {
      option: "merge",
      rationale: "检查和审核都通过",
      by: `assignment:${ops.id}`,
    },
  });
  expect(q.suggestion).not.toHaveProperty("return_reason");
  const view = decisionActionView(f.state, q).suggestion;
  expect(view).toMatchObject({ option: "merge", stale: false });
  expect(view).not.toHaveProperty("basis");
});

test("C-192: a suggested return carries its prefilled reason and becomes the recommendation", async () => {
  const { f, confirmation, escalate } = await setup();
  f.commit(
    escalate({
      option: "request_changes",
      rationale: "窄屏布局错位",
      return_reason: "修好 360px 下的按钮换行",
    }),
  );
  expect(confirmation()).toMatchObject({
    recommended: "request_changes",
    suggestion: {
      option: "request_changes",
      return_reason: "修好 360px 下的按钮换行",
    },
  });
});

test.each([
  [
    "without escalate",
    { option: "merge", rationale: "r" },
    { escalate: false },
  ],
  ["an unknown option", { option: "ship", rationale: "r" }, {}],
  ["hold on a merge confirmation", { option: "hold", rationale: "r" }, {}],
  [
    "a return without its reason",
    { option: "request_changes", rationale: "r" },
    {},
  ],
  [
    "a return reason on a merge suggestion",
    { option: "merge", rationale: "r", return_reason: "x" },
    {},
  ],
  ["an empty reason", { option: "merge", rationale: " " }, {}],
] as const)(
  "C-192: a suggestion with %s is rejected without any write",
  async (_label, suggestion, extra) => {
    const { confirmation, escalate } = await setup();
    const before = confirmation();
    expect(escalate(suggestion, extra)).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(confirmation()).toEqual(before);
  },
);

test("C-192: the human applies a fresh suggestion; actor stays human and the record says 按建议处理", async () => {
  const { f, confirmation, escalate, apply } = await setup();
  f.commit(escalate({ option: "merge", rationale: "检查和审核都通过" }));
  f.commit(apply(human, { raw_quote: "看过了" }));
  const q = confirmation();
  expect(q.status).toBe("resolved");
  expect(q.resolution).toMatchObject({
    option: "merge",
    resolved_by: "human",
    via: "needs_you",
    via_suggestion: true,
    rationale: "检查和审核都通过",
    raw_quote: "按建议处理：merge。看过了",
  });
  const event = f.state.events.findLast(
    (e) => e.type === "decision_resolved",
  ) as Event;
  expect(event.actor.kind).toBe("human");
  expect(event.payload).toMatchObject({
    option: "merge",
    via_suggestion: true,
  });
  expect(
    f.state.timeline.findLast((e) => e.type === "decision_resolved")?.body,
  ).toBe("按建议处理：merge。看过了");
});

test("C-192: a suggested return goes back with the human's (edited) reason", async () => {
  const { f, confirmation, escalate, apply } = await setup();
  f.commit(
    escalate({
      option: "request_changes",
      rationale: "窄屏布局错位",
      return_reason: "修好按钮换行",
    }),
  );
  f.commit(
    apply(human, {
      option: "request_changes",
      rationale: "修好按钮换行，并补暗色截图",
      raw_quote: "修好按钮换行，并补暗色截图",
    }),
  );
  const changes = f.state.events.findLast(
    (e) => e.type === "merge_changes_requested",
  );
  expect(changes?.payload).toMatchObject({
    reason: "修好按钮换行，并补暗色截图",
  });
  expect(confirmation().resolution).toMatchObject({
    option: "request_changes",
    via_suggestion: true,
  });
});

test("C-192: only a human can apply a suggestion; PM Office, PM Ops and producers are refused", async () => {
  const { f, confirmation, escalate, apply } = await setup();
  f.commit(escalate({ option: "merge", rationale: "检查和审核都通过" }));
  const before = confirmation();
  for (const actor of [officeActor, opsActor, f.actor(f.coder)])
    expect(apply(actor, {})).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
  expect(confirmation()).toEqual(before);
});

test("C-192: the suggested option is the only one the button can submit", async () => {
  const { f, escalate, apply } = await setup();
  f.commit(escalate({ option: "merge", rationale: "r" }));
  expect(
    apply(human, { option: "request_changes", raw_quote: "x", rationale: "x" }),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-192: without a suggestion the button is refused", async () => {
  const { f, escalate, apply } = await setup();
  f.commit(escalate());
  expect(apply(human, {})).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
});

test("C-192: a newer delivery, a changed merge check or a changed pre-merge check makes the suggestion stale", async () => {
  const { f, confirmation, escalate, apply } = await setup();
  f.commit(escalate({ option: "merge", rationale: "r" }));
  const q = confirmation();
  expect(suggestionStale(f.state, q)).toBe(false);
  const card = f.card.id;
  const lastSeq = Math.max(0, ...f.state.events.map((e) => e.seq));
  const completion = f.state.deliveries.findLast(
    (d) => d.kind === "card_completion",
  );
  if (!completion) throw new Error("Missing completion");
  const [first] = f.state.deliveries;
  if (!first) throw new Error("Missing delivery");
  const changed: [string, CommandState][] = [
    [
      "delivery",
      {
        ...f.state,
        deliveries: [
          ...f.state.deliveries,
          { ...first, id: "D-999" as typeof first.id },
        ],
      },
    ],
    [
      "merge check",
      {
        ...f.state,
        events: [
          ...f.state.events,
          {
            ...(f.state.events.at(-1) as Event),
            id: "check" as Event["id"],
            seq: lastSeq + 1,
            card_id: card,
            type: "merge_check_finished",
            payload: {
              attempt_id: "attempt-1",
              completion_id: completion.id,
              status: "failed",
              checks: [],
            },
          },
        ],
      },
    ],
    [
      "pre-merge check",
      {
        ...f.state,
        cards: f.state.cards.map((c) =>
          c.id === card
            ? {
                ...c,
                pre_merge_checks: [
                  {
                    label: "截图核对",
                    status: "passed",
                    updated_by: "human",
                    updated_at: "2026-11-13T00:00:00.000Z",
                  },
                ],
              }
            : c,
        ),
      },
    ],
  ];
  for (const [label, state] of changed) {
    expect(suggestionStale(state, q), label).toBe(true);
    expect(decisionActionView(state, q).suggestion?.stale, label).toBe(true);
    expect(apply(human, {}, state), label).toMatchObject({
      ok: false,
      error: { code: "stale_target" },
    });
  }
});

test("C-192: request_decision accepts a suggestion matching the recommendation, and the human applies it", async () => {
  const { f } = await setup();
  const params: RequestDecisionParams = {
    card_id: f.card.id,
    // A human-only category, so PM Ops does not take it over.
    category: "permission",
    kind: "choose",
    question: "Which layout?",
    context: "Both work",
    options: [
      { key: "a", description: "Left", impact: "Keeps width" },
      { key: "b", description: "Right", impact: "Wider" },
    ],
    recommended: "a",
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "human",
  };
  expect(
    requestDecision(
      f.state,
      officeActor,
      { ...params, suggestion: { option: "b", rationale: "r" } },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const q = f.commit(
    requestDecision(
      f.state,
      officeActor,
      { ...params, suggestion: { option: "a", rationale: "更省空间" } },
      f.io,
    ),
  );
  expect(q.suggestion).toMatchObject({ option: "a", rationale: "更省空间" });
  const resolved = f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "a",
        rationale: "",
        raw_quote: "",
        via_suggestion: true,
      },
      f.io,
    ),
  );
  expect(resolved.resolution).toMatchObject({
    option: "a",
    via_suggestion: true,
    raw_quote: "按建议处理：a",
    rationale: "更省空间",
  });
});
