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
  EXT_MESSAGE_FILTER_DEFAULTS,
  EXT_MESSAGE_KINDS,
  type ExtMessageFilter,
  type ExtMessageItem,
  extMessageAllowed,
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
test("C-580 default filter pushes decisions, actions and human merge confirmations, never notices", () => {
  expect(EXT_MESSAGE_FILTER_DEFAULTS).toEqual({
    kinds: {
      decision: true,
      human_action: true,
      merge_confirmation: true,
      notice: false,
    },
    excluded_projects: [],
  });
  expect(
    EXT_MESSAGE_KINDS.filter((kind) =>
      extMessageAllowed(EXT_MESSAGE_FILTER_DEFAULTS, { ...item, kind }),
    ),
  ).toEqual(["decision", "human_action", "merge_confirmation"]);
  // A project created after the filter was saved is pushed by default.
  expect(
    extMessageAllowed(EXT_MESSAGE_FILTER_DEFAULTS, {
      kind: "decision",
      project_id: "created-later",
    }),
  ).toBe(true);
});
test("C-580 kinds and projects filter independently; excluding one project never mutes another", () => {
  const filter: ExtMessageFilter = {
    kinds: {
      decision: false,
      human_action: true,
      merge_confirmation: true,
      notice: true,
    },
    excluded_projects: ["sensen-godot"],
  };
  const allowed = (kind: ExtMessageItem["kind"], project_id: string) =>
    extMessageAllowed(filter, { kind, project_id });
  expect(allowed("decision", "cardigan")).toBe(false);
  expect(allowed("notice", "cardigan")).toBe(true);
  expect(allowed("human_action", "cardigan")).toBe(true);
  for (const kind of EXT_MESSAGE_KINDS)
    expect(allowed(kind, "sensen-godot")).toBe(false);
  // Prefixes and lookalikes are distinct projects.
  expect(allowed("notice", "sensen")).toBe(true);
  expect(allowed("notice", "sensen-godot-2")).toBe(true);
  // A missing kind (older or hand-edited configuration) is not pushed.
  expect(
    extMessageAllowed(
      {
        kinds: { decision: true } as ExtMessageFilter["kinds"],
        excluded_projects: [],
      },
      { kind: "notice", project_id: "cardigan" },
    ),
  ).toBe(false);
});
test("C-580 merge confirmation items are only those the human decides", () => {
  const merge = {
    ...decision,
    trigger: "merge_confirmation" as const,
    question: "将 C-1 合并到 main？",
  };
  const state = {
    ...fixture(),
    decisions: [
      merge,
      {
        ...merge,
        id: id("decision", 2),
        key: id("decision", 2),
        decider: "system" as const,
      },
      {
        ...merge,
        id: id("decision", 3),
        key: id("decision", 3),
        decider: "role:pm" as const,
      },
    ],
    events: [
      event("decision_requested", { decision_id: "Q-1" }, 1),
      event("system_merge_pending", { decision_id: "Q-2" }, 2),
      event("decision_requested", { decision_id: "Q-3" }, 3),
    ],
  };
  const items = extMessageItems(state, state.project_id);
  expect(items.map((i) => [i.item_id, i.kind])).toEqual([
    ["Q-1", "merge_confirmation"],
  ]);
  expect(
    items.every((i) => extMessageAllowed(EXT_MESSAGE_FILTER_DEFAULTS, i)),
  ).toBe(true);
});
test("projection preserves creation, readiness and repeated routing times without exporting them", () => {
  const state = fixture();
  const card_id = state.cards[0]!.id;
  const gate = { kind: "card_merged" as const, card_id };
  const at = "2026-01-01T00:02:10.000Z";
  const origin = event(
    "human_action_requested",
    { human_action_id: action.id },
    1,
  );
  const trigger = {
    ...event("card_merged", {}, 2),
    created_at: "2026-01-01T00:01:59.999Z",
  };
  const fact = {
    ...event(
      "needs_you_item_ready",
      {
        human_action_id: action.id,
        condition: { card_id, kind: "card_merged" },
        source_event_id: trigger.id,
      },
      3,
    ),
    created_at: at,
  };
  const project = (h: HumanAction, events: Event[]) =>
    extMessageItems(
      {
        ...state,
        cards: state.cards.map((c) => ({ ...c, status: "done" as const })),
        human_actions: [h],
        events,
      },
      state.project_id,
    )[0]!;
  const reroute = {
    ...origin,
    id: event("human_action_requested", {}, 4).id,
    seq: 4,
    created_at: "2026-01-01T00:03:00.000Z",
  };
  const ready = project({ ...action, ready_when: gate }, [
    origin,
    trigger,
    fact,
    reroute,
  ]);
  expect(ready).toMatchObject({
    ready: true,
    event_id: origin.id,
    activity_at: [
      origin.created_at,
      at,
      trigger.created_at,
      reroute.created_at,
    ],
  });
  expect(ready.undated_ready).toBeUndefined();
  expect(project({ ...action, ready_when: gate }, [origin]).undated_ready).toBe(
    true,
  );
  expect(
    project(
      {
        ...action,
        ready_when: { kind: "manual" },
        ready_released: { by: "human", reason: "fixture", at },
      },
      [origin],
    ).activity_at,
  ).toEqual([origin.created_at, at]);
  expect(
    buildExtMessage(ready, "https://workbench.invalid"),
  ).not.toHaveProperty("activity_at");
});
test("projection preserves the first source in stream order and canonical handoff groups", () => {
  const second = { ...decision, id: id("decision", 2), key: id("decision", 2) };
  const state = {
    ...fixture(),
    decisions: [decision, second].map((q) => ({
      ...q,
      handoff_group: "shared",
    })),
    human_actions: [action],
    events: [
      event(
        "decision_requested",
        { decision_id: decision.id, human_action_id: action.id },
        2,
      ),
      event("decision_requested", { decision_id: second.id }, 3),
      event(
        "legacy",
        { decision_id: decision.id, human_action_id: action.id },
        1,
      ),
    ],
  };
  expect(
    extMessageItems(state, state.project_id).map((i) => [
      i.item_id,
      i.event_id,
      i.handled,
    ]),
  ).toEqual([
    [decision.id, "event-2", false],
    [second.id, "event-3", true],
    [action.id, "event-2", false],
  ]);
});
test("failed checks on confirmed merges stay visible without a full event scan per decision", async () => {
  const f = mergeFixture();
  const { completion } = await f.accept();
  const confirmation = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation",
  )!;
  const base = {
    ...f.state,
    decisions: [{ ...confirmation, decider: "human" as const }],
  };
  const confirmed = value(
    recordDecision(
      base,
      human,
      {
        decision_id: confirmation.id,
        option: "merge",
        raw_quote: "同意",
        rationale: "已查看",
      },
      f.io,
    ),
  ).data;
  const work = base.work_items.find((w) => w.id === completion.work_item_id)!;
  const cases = Array.from({ length: 8 }, (_, i) => {
    const n = i + 1;
    const card_id = id("card", n),
      work_item_id = id("work_item", n),
      completion_id = id("delivery", n),
      decision_id = id("decision", n);
    return {
      card: { ...f.card, id: card_id, status: "awaiting_merge" as const },
      work: { ...work, id: work_item_id, card_id },
      completion: {
        ...completion,
        id: completion_id,
        work_item_id,
        status: "accepted" as const,
      },
      decision: {
        ...confirmed,
        id: decision_id,
        key: decision_id,
        card_id,
        kind: "approve" as const,
        target: { delivery_id: completion_id },
      },
      events: [
        { ...event("decision_requested", { decision_id }, n * 2), card_id },
        {
          ...event(
            "merge_check_finished",
            {
              completion_id,
              attempt_id: `check-${n}`,
              status: "failed",
              checks: [],
            },
            n * 2 + 1,
          ),
          card_id,
        },
      ],
    };
  });
  function historyVisits(count: number) {
    // Count actual visits to an unrelated history slot, not elapsed time or a
    // specific Array method. Both projections start with a fresh, equal-sized snapshot.
    const unrelated = event("comment_posted", {}, 0);
    const events = [unrelated, ...cases.flatMap((entry) => entry.events)];
    let visits = 0;
    Object.defineProperty(events, 0, {
      get: () => {
        visits++;
        return unrelated;
      },
    });
    const state = {
      ...base,
      events,
      cards: cases.map((c) => c.card),
      work_items: cases.map((c) => c.work),
      deliveries: cases.map((c) => c.completion),
      decisions: cases.slice(0, count).map((c) => c.decision),
    };
    expect(
      extMessageItems(state, state.project_id)
        .filter((i) => i.kind === "merge_confirmation" && !i.handled && i.ready)
        .map((i) => i.item_id),
    ).toEqual(state.decisions.map((q) => q.id));
    return visits;
  }
  const single = historyVisits(1);
  expect(single).toBeGreaterThan(0);
  expect(historyVisits(cases.length)).toBe(single);
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

test("a summary carries only its eligible count and the workbench entrance", () => {
  expect(buildExtMessageDigest(23, "https://workbench.invalid")).toEqual({
    title: "23 条待处理",
    url: "https://workbench.invalid",
  });
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
  expect(before.options.map((o) => o.key)).toEqual(["a", "_other"]);
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
  expect(ops.options.map((o) => o.key)).toEqual(["merge", "hold", "_other"]);
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
  expect(issued.options.map((o) => o.key)).toEqual(["merge", "hold", "_other"]);
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

test("C-674: with the project code the message carries the full number; sensitive items do not", () => {
  expect(
    buildExtMessage(item, "https://workbench.invalid", 120, "SEN"),
  ).toMatchObject({ card: "C-1", item: "Q-1", ref: "SEN-C-1" });
  const { card_id: _card, ...projectItem } = item;
  expect(
    buildExtMessage(projectItem, "https://workbench.invalid", 120, "SEN"),
  ).toMatchObject({ card: null, ref: "SEN-Q-1" });
  expect(
    Object.keys(
      buildExtMessage(
        { ...item, sensitive: true },
        "https://workbench.invalid",
        120,
        "SEN",
      ),
    ).sort(),
  ).toEqual(["project", "title", "url"]);
});
