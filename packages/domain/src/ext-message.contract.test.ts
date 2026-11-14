import { expect, test } from "vitest";
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
import {
  buildExtMessage,
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
test("sensitive payload contains only the fixed prompt and link", () => {
  expect(
    buildExtMessage(
      { ...item, sensitive: true, title: "SECRET" },
      "https://workbench.invalid",
    ),
  ).toEqual({
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
