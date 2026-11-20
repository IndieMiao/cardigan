import { expect, test } from "vitest";
import { recordDecision } from "./commands/coordination.js";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import { markNoticesRead, notices } from "./commands/notices.js";
import {
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./commands/test-fixtures.js";
import type { Decision, Event, HumanAction } from "./entities.js";
import { extInteraction } from "./ext-interaction.js";
import {
  buildExtMessage,
  buildExtMessageDigest,
  EXT_MESSAGE_DEFAULTS,
  type ExtMessageItem,
  extMessageItems,
} from "./ext-message.js";

const item: ExtMessageItem = {
  project_id: "fictional",
  card_id: id("card", 1),
  event_id: ports().ids.nextEventId(),
  item_id: "Q-1",
  kind: "decision",
  title: "请确认",
  sensitive: false,
  handled: false,
  ready: true,
};
test.each([
  "decision",
  "merge_confirmation",
  "human_action",
  "notice",
] as const)("%s exports only approved fields and a deep link", (kind) => {
  const message = buildExtMessage(
    {
      ...item,
      kind,
      ...(kind === "human_action" ? { item_id: "H-1" } : {}),
      ...(kind === "notice" ? { anchor: "decision-Q-1" } : {}),
    },
    "https://workbench.invalid",
  );
  expect(Object.keys(message).sort()).toEqual([
    "card",
    "item",
    "kind",
    "project",
    "title",
    "url",
  ]);
  expect(message.url).toBe(
    `https://workbench.invalid/#/p/fictional/cards/C-1?at=${kind === "human_action" ? "human-action-H-1" : "decision-Q-1"}`,
  );
});
test("sensitive payload contains only the project, fixed prompt and link", () => {
  expect(
    buildExtMessage(
      { ...item, sensitive: true, title: "SECRET" },
      "https://workbench.invalid",
    ),
  ).toEqual({
    project: "fictional",
    title: "有 1 条敏感事项待处理",
    url: "https://workbench.invalid/#/p/fictional/cards/C-1?at=decision-Q-1",
  });
});
test("title limit counts Unicode code points; missing fields never fall back to body", () => {
  expect(
    buildExtMessage(
      { ...item, title: "😀".repeat(121) },
      "https://workbench.invalid",
    ).title,
  ).toBe("😀".repeat(120));
  expect(
    buildExtMessage(
      { ...item, title: "😀".repeat(10) },
      "https://workbench.invalid",
      2,
    ).title,
  ).toBe("😀😀");
  expect(
    buildExtMessage({ ...item, title: " " }, "https://workbench.invalid").title,
  ).toBe("有新的拍板事项");
  const { card_id: _card, ...projectItem } = item;
  expect(buildExtMessage(projectItem, "https://workbench.invalid").url).toBe(
    "https://workbench.invalid/#/p/fictional/needs-you",
  );
  expect(EXT_MESSAGE_DEFAULTS).toEqual({
    timeout_ms: 10000,
    max_attempts: 3,
    retry_delays_ms: [30000, 60000],
    title_limit: 120,
    digest_limit: 20,
  });
});
const decision: Decision = {
  id: id("decision", 1),
  key: id("decision", 1),
  kind: "choose",
  card_id: id("card", 1),
  question: "请选择方案",
  context: "PRIVATE context",
  plain_summary: { changed: "PRIVATE summary", impact: "PRIVATE", risk: "无" },
  category: "general",
  raised_by: "human",
  options: [],
  recommended: "",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  doc_refs: [],
  status: "open",
};
const action: HumanAction = {
  id: id("human_action", 1),
  key: id("human_action", 1),
  card_id: id("card", 1),
  category: "general",
  requested_by: "human",
  instructions: "PRIVATE instructions",
  why_human: "PRIVATE reason",
  expected_return: "PRIVATE return",
  blocked_work_items: [],
  status: "open",
  handoff: {
    title: "请检查设置",
    summary: "PRIVATE",
    instructions: "PRIVATE",
    why_human: "PRIVATE",
    expected_outcome: "PRIVATE",
    expected_return: "PRIVATE",
    rewritten_by: "human",
    rewritten_at: "2026-01-01T00:00:00.000Z",
  },
};
const event = (
  type: string,
  payload: Event["payload"],
  seq: number,
): Event => ({
  id: `event-${seq}` as Event["id"],
  card_id: id("card", 1),
  seq,
  type,
  payload,
  actor: human,
  created_at: "2026-01-01T00:00:00.000Z",
});
test("projection follows current handled/readiness state, preferred title and all affected sensitive cards", () => {
  const state = {
    ...fixture(),
    decisions: [decision],
    human_actions: [action],
    events: [
      event("decision_requested", { decision_id: "Q-1" }, 1),
      event("human_action_requested", { human_action_id: "H-1" }, 2),
    ],
  };
  const project = state.project_id;
  expect(extMessageItems(state, project).map((i) => i.title)).toEqual([
    "请选择方案",
    "请检查设置",
  ]);
  expect(
    JSON.stringify(
      extMessageItems(state, project).map((i) =>
        buildExtMessage(i, "https://workbench.invalid"),
      ),
    ),
  ).not.toContain("PRIVATE");
  expect(
    extMessageItems(
      { ...state, human_actions: [{ ...action, triage: "pm_ops" }] },
      project,
    ).some((i) => i.kind === "human_action"),
  ).toBe(false);
  const deferred = {
    ...state,
    decisions: [{ ...decision, ready_when: { kind: "manual" as const } }],
    human_actions: [{ ...action, status: "done" as const }],
  };
  expect(extMessageItems(deferred, project)).toMatchObject([
    { ready: false, handled: false },
    { handled: true },
  ]);
  const sensitive = {
    ...state,
    cards: state.cards.map((c) => ({ ...c, sensitive: c.id === "C-2" })),
    decisions: [{ ...decision, affected_cards: [id("card", 2)] }],
  };
  expect(extMessageItems(sensitive, project)[0]?.sensitive).toBe(true);
  expect(
    extMessageItems({ ...state, cards: [] }, project).every((i) => i.sensitive),
  ).toBe(true);
});
test("final failure becomes one readable Workbench notice and never enters external projection", () => {
  const failed = {
    ...event(
      "ext_message_failed",
      { final: true, channel: "fake", item_id: "H-1", attempts: 3 },
      3,
    ),
    actor: { kind: "system" as const, project_id: human.project_id },
  };
  const state = { ...fixture(), events: [failed] };
  expect(notices(state)).toMatchObject([
    { kind: "external_message", decision_id: null, read: false },
  ]);
  expect(extMessageItems(state, state.project_id)).toEqual([]);
  const next = apply(
    state,
    value(markNoticesRead(state, human, { notice_ids: [failed.id] }, ports())),
  );
  expect(notices(next)[0]?.read).toBe(true);
});

test("delegated notices use the question title, omit the notice body and respect read state", () => {
  const state = {
    ...fixture(),
    decisions: [{ ...decision, status: "resolved" as const }],
    events: [
      event(
        "decision_resolved",
        {
          decision_id: decision.id,
          via: "delegated",
          notice: "PRIVATE notice body",
        },
        7,
      ),
    ],
  };
  const notice = extMessageItems(state, state.project_id).find(
    (i) => i.kind === "notice",
  );
  expect(notice).toMatchObject({
    title: decision.question,
    handled: false,
    anchor: "decision-Q-1",
  });
  if (!notice) throw new Error("Missing notice");
  expect(
    JSON.stringify(buildExtMessage(notice, "https://workbench.invalid")),
  ).not.toContain("PRIVATE");
  const next = apply(
    state,
    value(
      markNoticesRead(state, human, { notice_ids: [notice.item_id] }, ports()),
    ),
  );
  expect(
    extMessageItems(next, next.project_id).find((i) => i.kind === "notice")
      ?.handled,
  ).toBe(true);
});

test("digest filters current state and project, truncates titles and items, and redacts sensitive metadata", () => {
  const pending = Array.from({ length: 23 }, (_, n) => ({
    ...item,
    item_id: `Q-${n + 1}`,
    title: "😀".repeat(130),
    sensitive: n === 0,
  }));
  const digest = buildExtMessageDigest(
    "fictional",
    [
      ...pending,
      { ...item, handled: true, title: "PRIVATE handled" },
      { ...item, ready: false, title: "PRIVATE deferred" },
      { ...item, project_id: "other", title: "PRIVATE other" },
    ],
    "https://workbench.invalid",
  );
  expect(digest.title).toBe("免打扰期间 23 条待处理");
  expect(digest.url).toBe("https://workbench.invalid/#/p/fictional/needs-you");
  if (!("items" in digest)) throw new Error("Expected digest");
  expect(digest.items).toHaveLength(20);
  expect(digest.items[0]).toEqual({
    project: "fictional",
    title: "有 1 条敏感事项待处理",
    url: "https://workbench.invalid/#/p/fictional/cards/C-1?at=decision-Q-1",
  });
  expect(digest.items[1]?.title).toBe("😀".repeat(120));
  expect(JSON.stringify(digest)).not.toContain("PRIVATE");
  const configured = buildExtMessageDigest(
    "fictional",
    pending,
    "https://workbench.invalid",
    {
      ...EXT_MESSAGE_DEFAULTS,
      title_limit: 2,
      digest_limit: 1,
    },
  );
  expect(configured).toMatchObject({ total: 23, items: [digest.items[0]] });
});

test("interactive eligibility is lost when a linked item is restricted, held by someone else, or unresolvable", () => {
  const base = fixture();
  const q: Decision = {
    ...decision,
    options: [{ key: "a", description: "A", impact: "none" }],
  };
  const input = { ...item, project_id: base.project_id, card_id: q.card_id! };
  const s = { ...base, decisions: [q] };
  const before = extInteraction(s, input);
  expect(before.options.map((o) => o.key)).toEqual(["a"]);
  expect(
    extInteraction({ ...s, decisions: [{ ...q, question: "Other" }] }, input)
      .basis,
  ).not.toBe(before.basis);
  for (const category of ["publish", "data_deletion", "scope_change"] as const)
    expect(
      extInteraction({ ...s, decisions: [{ ...q, category }] }, input).options,
    ).toEqual([]);
  expect(extInteraction({ ...s, cards: [] }, input)).toMatchObject({
    sensitive: true,
    options: [],
  });
  expect(
    extInteraction(
      { ...s, cards: s.cards.map((c) => ({ ...c, sensitive: true })) },
      input,
    ).options,
  ).toEqual([]);
  expect(
    extInteraction({ ...s, decisions: [{ ...q, decider: "role:pm" }] }, input)
      .options,
  ).toEqual([]);
});
test("real merge confirmation only offers merge/hold against the current completion; inherited publish never gets a button", async () => {
  const f = mergeFixture();
  await f.accept();
  const q = f.state.decisions.find((d) => d.trigger === "merge_confirmation")!;
  const s = { ...f.state, decisions: [{ ...q, decider: "human" as const }] };
  const input = {
    ...item,
    project_id: s.project_id,
    card_id: f.card.id,
    kind: "merge_confirmation" as const,
    item_id: q.id,
  };
  const ops = extInteraction(s, input);
  expect(ops.options.map((o) => o.key)).toEqual(["merge", "hold"]);
  for (const option of ["merge", "hold"]) {
    const result = recordDecision(
      s,
      human,
      { decision_id: q.id, option, raw_quote: "同意", rationale: "已查看" },
      f.io,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.data.status).toBe(
        option === "merge" ? "resolved" : "snoozed",
      );
  }
  expect(
    extInteraction(
      { ...s, project_settings: { merge_gate_enabled: true } },
      input,
    ).options.map((o) => o.key),
  ).not.toContain("merge");
  const source: Decision = {
    ...decision,
    id: id("decision", 999),
    category: "publish",
  };
  const risky = {
    ...s,
    cards: s.cards.map((c) => ({
      ...c,
      source: { kind: "decision" as const, decision_id: source.id },
    })),
    decisions: [...s.decisions, source],
  };
  expect(extInteraction(risky, input).options).toEqual([]);
  expect(
    extInteraction(
      {
        ...s,
        human_actions: [
          { ...action, category: "data_deletion", card_id: f.card.id },
        ],
      },
      input,
    ).options,
  ).toEqual([]);
});

test("unclassified actions are link-only and unrelated actions on the same card cannot expire one another", () => {
  const { category: _category, ...uncategorized } = action;
  const sibling = {
    ...action,
    id: id("human_action", 2),
    key: id("human_action", 2),
  };
  const s = { ...fixture(), human_actions: [action, sibling] };
  const input = {
    ...item,
    project_id: s.project_id,
    kind: "human_action" as const,
    item_id: action.id,
  };
  const before = extInteraction(s, input);
  expect(before.options.map((o) => o.key)).toEqual(["complete"]);
  expect(
    extInteraction({ ...s, human_actions: [uncategorized] }, input).options,
  ).toEqual([]);
  expect(
    extInteraction(
      {
        ...s,
        human_actions: [action, { ...sibling, status: "done" }],
        events: [
          ...s.events,
          event("human_action_completed", { human_action_id: sibling.id }, 999),
        ],
      },
      input,
    ),
  ).toEqual(before);
});

async function sourceApproval() {
  const f = mergeFixture();
  await f.accept();
  const q = f.state.decisions.find((d) => d.trigger === "merge_confirmation")!;
  const other = { ...f.card, id: id("card", 20) };
  const work = {
    ...f.state.work_items[0]!,
    id: id("work_item", 20),
    card_id: other.id,
  };
  const target = {
    ...f.state.deliveries[0]!,
    id: id("delivery", 20),
    work_item_id: work.id,
  };
  const source: Decision = {
    ...decision,
    id: id("decision", 20),
    card_id: f.card.id,
    kind: "approve",
    target: { delivery_id: target.id },
    affected_cards: [],
    affected_work_items: [],
  };
  const s = {
    ...f.state,
    cards: [
      {
        ...f.state.cards[0]!,
        source: { kind: "decision" as const, decision_id: source.id },
      },
      other,
    ],
    work_items: [...f.state.work_items, work],
    deliveries: [...f.state.deliveries, target],
    decisions: [{ ...q, decider: "human" as const }, source],
  };
  const input = {
    ...item,
    project_id: s.project_id,
    card_id: f.card.id,
    kind: "merge_confirmation" as const,
    item_id: q.id,
  };
  return { s, other, target, input };
}
test("source approvals trace the target delivery's card for merge cards; unknown target fails closed", async () => {
  const { s, other, target, input } = await sourceApproval();
  expect(
    extInteraction(
      {
        ...s,
        cards: s.cards.map((c) =>
          c.id === other.id ? { ...c, sensitive: true } : c,
        ),
      },
      input,
    ),
  ).toMatchObject({ sensitive: true, options: [] });
  expect(
    extInteraction(
      { ...s, deliveries: s.deliveries.filter((d) => d.id !== target.id) },
      input,
    ),
  ).toMatchObject({ sensitive: true, options: [] });
});
test("a merge action issued before its source approval's target becomes sensitive loses its version and choices", async () => {
  const { s, other, input } = await sourceApproval();
  const issued = extInteraction(s, input);
  expect(issued.options.map((o) => o.key)).toEqual(["merge", "hold"]);
  const fresh = extInteraction(
    {
      ...s,
      cards: s.cards.map((c) =>
        c.id === other.id ? { ...c, sensitive: true } : c,
      ),
    },
    input,
  );
  expect(fresh.basis).not.toEqual(issued.basis);
  expect(fresh.options).toEqual([]);
});
