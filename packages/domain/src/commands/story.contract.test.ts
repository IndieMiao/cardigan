import { expect, test } from "vitest";
import type { Card } from "../entities.js";
import { storyProgress } from "../story.js";
import {
  type StoryDiscussion,
  storyDiscussionRounds,
} from "../story-discussion.js";
import { generalCardTemplate, storyCardTemplate } from "../templates.js";
import { postComment, requestDecision } from "./coordination.js";
import type { CommandState } from "./core.js";
import { assign, createCard, updateCard } from "./pm.js";
import { manageCardTemplate, markCardDone } from "./templates.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

function setup() {
  let state: CommandState = fixture();
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "office" } : a,
    ),
  };
  const p = ports();
  const request = (template_id: string, parent_card_id?: Card["id"]) =>
    createCard(
      state,
      human,
      {
        template_id,
        title: "Request",
        goal: "Original need",
        source: { kind: "quote", text: "Original need" },
        ...(parent_card_id ? { parent_card_id } : {}),
      },
      p,
    );
  const create = (template: string, parent?: Card["id"]) => {
    const x = value(request(template, parent));
    state = apply(state, x);
    return x.data;
  };
  const parent = create("story");
  const cancel = (
    card: Card,
    action?: "cancel" | "detach",
    ids: Card["id"][] = [],
  ) =>
    updateCard(
      state,
      human,
      {
        card_id: card.id,
        status: "cancelled",
        ...(action ? { story_children: { action, ids } } : {}),
      },
      p,
    );
  const done = (card: Card) =>
    value(
      markCardDone(state, human, { card_id: card.id, result: "Reviewed" }, p),
    );
  const summary = () =>
    postComment(
      state,
      actor(4, "pm"),
      {
        card_id: parent.id,
        body: "Compared to original request",
        story_summary: true,
      },
      p,
    );
  return {
    create,
    request,
    cancel,
    done,
    summary,
    parent,
    p,
    get state() {
      return state;
    },
    apply: (effect: Parameters<typeof apply>[1]) => {
      state = apply(state, effect);
    },
  };
}

test("story has exactly one standing Office task and accepts only same-project non-story children", () => {
  const f = setup(),
    { parent } = f;
  expect(parent).toMatchObject({
    template: "story",
    merge_policy: "none",
    story: {},
  });
  expect(parent.repo).toBeUndefined();
  const items = f.state.work_items.filter((w) => w.card_id === parent.id);
  expect(items).toMatchObject([
    { role_id: "pm", title: "拆解", kind: "produce" },
  ]);
  if (!items[0]) throw new Error("missing decomposition");
  expect(
    assign(f.state, human, { work_item_id: items[0].id, role_id: "pm" }, f.p)
      .ok,
  ).toBe(false);
  expect(f.request("story", parent.id).ok).toBe(false);
  const child = f.create("general", parent.id);
  expect(child.depends_on_cards).toBeUndefined();
  expect(f.request("general", child.id).ok).toBe(false);
  expect(
    createCard(
      { ...f.state, cards: [{ ...parent, project_id: "another" }] },
      human,
      {
        title: "x",
        goal: "x",
        source: { kind: "quote", text: "x" },
        template: "general",
        parent_card_id: parent.id,
      },
      f.p,
    ).ok,
  ).toBe(false);
  expect(storyProgress(f.state.cards, parent)).toMatchObject({
    total: 1,
    finished: 0,
    counts: { todo: 1, done: 0 },
    children: [{ id: child.id }],
  });
});

test("last child emits one system fact; only Office submits the summary and only a human closes", () => {
  const f = setup(),
    { parent } = f;
  expect(f.summary().ok).toBe(false);
  const a = f.create("general", parent.id),
    b = f.create("general", parent.id);
  f.apply(f.done(a));
  expect(f.summary().ok).toBe(false);
  const cancelled = value(f.cancel(b));
  f.apply(cancelled);
  expect(
    cancelled.timeline.filter((e) => e.card_id === parent.id),
  ).toMatchObject([{ author: "system" }]);
  expect(
    f.state.events.filter((e) => e.type === "story_children_settled"),
  ).toMatchObject([{ card_id: parent.id, actor: { kind: "system" } }]);
  expect(
    value(f.cancel(b)).events.filter(
      (e) => e.type === "story_children_settled",
    ),
  ).toEqual([]);
  expect(storyProgress(f.state.cards, parent)).toMatchObject({
    finished: 2,
    total: 2,
    counts: { done: 1, cancelled: 1 },
  });
  const ops = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" as const } : a,
    ),
  };
  expect(
    postComment(
      ops,
      actor(4, "pm"),
      { card_id: parent.id, body: "Ops", story_summary: true },
      f.p,
    ).ok,
  ).toBe(false);
  f.apply(value(f.summary()));
  expect(f.state.cards.find((c) => c.id === parent.id)).toMatchObject({
    status: "review",
    story: { summary_entry_id: expect.any(String) },
  });
  const extra = f.create("general", parent.id);
  expect(f.state.cards.find((c) => c.id === parent.id)?.story).toEqual({});
  expect(f.summary().ok).toBe(false);
  f.apply(f.done(extra));
  f.apply(value(f.summary()));
  expect(
    markCardDone(
      f.state,
      actor(4, "pm"),
      { card_id: parent.id, result: "Confirmed" },
      f.p,
    ).ok,
  ).toBe(false);
  f.apply(f.done(parent));
  expect(f.state.cards.find((c) => c.id === parent.id)?.status).toBe("done");
  expect(f.request("general", parent.id).ok).toBe(false);
});

test.each(["cancel", "detach"] as const)(
  "cancel story rechecks human choice (%s), never rewrites terminal children",
  (action) => {
    const f = setup(),
      { parent } = f;
    const ended = f.create("general", parent.id),
      active = f.create("general", parent.id);
    f.apply(f.done(ended));
    expect(f.cancel(parent).ok).toBe(false);
    expect(f.cancel(parent, action, [ended.id]).ok).toBe(false);
    expect(
      updateCard(
        f.state,
        actor(4, "pm"),
        {
          card_id: parent.id,
          status: "cancelled",
          story_children: { action, ids: [active.id] },
        },
        f.p,
      ).ok,
    ).toBe(false);
    f.apply(value(f.cancel(parent, action, [active.id])));
    expect(f.state.cards.find((c) => c.id === parent.id)?.status).toBe(
      "cancelled",
    );
    expect(f.state.cards.find((c) => c.id === ended.id)).toMatchObject({
      status: "done",
      parent_card_id: parent.id,
    });
    const child = f.state.cards.find((c) => c.id === active.id);
    expect(child?.status).toBe(action === "cancel" ? "cancelled" : "todo");
    expect(child?.parent_card_id).toBe(
      action === "cancel" ? parent.id : undefined,
    );
    expect(
      f.state.events.some((e) => e.type === "story_children_settled"),
    ).toBe(false);
  },
);

test("early human completion preserves active children without manufacturing an Office summary", () => {
  const f = setup();
  const child = f.create("general", f.parent.id);
  f.apply(f.done(f.parent));
  expect(f.state.cards.find((c) => c.id === child.id)).toEqual(child);
  expect(
    f.state.work_items.find((w) => w.card_id === f.parent.id)?.status,
  ).toBe("cancelled");
});

test("a migrated builtin uses the Office comment tool, never loosening ordinary produce items", () => {
  const state = fixture();
  const p = ports();
  const custom = {
    ...generalCardTemplate,
    id: "story",
    title: "Legacy",
    builtin: false,
  };
  const migrated = { ...storyCardTemplate, id: "builtin-story" };
  const ordinary = { ...storyCardTemplate, id: "custom-work", builtin: false };
  const narrowed: CommandState = {
    ...state,
    roles: state.roles.map((r) =>
      r.role_id === "pm"
        ? { ...r, capabilities: ["verify"], allowed_tools: ["post_comment"] }
        : r,
    ),
    card_templates: [custom, migrated, ordinary],
  };
  const input = {
    title: "Need",
    goal: "Goal",
    source: { kind: "quote", text: "Original" },
  } as const;
  const request = (template_id: string) =>
    createCard(narrowed, human, { ...input, template_id }, p);
  expect(value(request(custom.id)).data.story).toBeUndefined();
  expect(value(request(migrated.id)).data.story).toEqual({});
  expect(request(ordinary.id).ok).toBe(false);
  expect(
    createCard(
      {
        ...narrowed,
        roles: narrowed.roles.map((r) => ({ ...r, allowed_tools: [] })),
      },
      human,
      { ...input, template_id: migrated.id },
      p,
    ).ok,
  ).toBe(false);
  expect(
    value(
      manageCardTemplate(
        narrowed,
        human,
        { action: "update", definition: { ...custom, title: "Edited" } },
        p,
      ),
    ).data,
  ).toMatchObject({ version: 2, builtin: false });
  expect(
    manageCardTemplate(
      narrowed,
      human,
      { action: "deactivate", template_id: migrated.id },
      p,
    ).ok,
  ).toBe(false);
});

const ask = {
  action: "ask",
  questions: [
    { question: "布局？", recommended: "单列", impact: "便于阅读" },
    { question: "顺序？", recommended: "按时间", impact: "新内容排在后面" },
  ],
} as const;

function discussionFixture() {
  const f = setup(),
    office = actor(4, "pm");
  const post = (
    a: typeof human,
    story_discussion: StoryDiscussion,
    id = f.parent.id,
  ) =>
    postComment(
      f.state,
      a,
      { card_id: id, body: "讨论", story_discussion },
      f.p,
    );
  const send = (a: typeof human, action: StoryDiscussion) => {
    const effect = value(post(a, action));
    f.apply(effect);
    if (!effect.data) throw new Error("Missing discussion entry");
    return effect.data;
  };
  const story = () => {
    const state = f.state.cards.find((c) => c.id === f.parent.id)?.story;
    if (!state) throw new Error("Missing story");
    return state;
  };
  return { f, office, post, send, story };
}

test("one round per group with a human response; implicit defaults never approve work", () => {
  const { f, office, send, post, story } = discussionFixture();
  const first = send(office, ask).id;
  const explicit = {
    action: "answer",
    group_id: first,
    number: 1,
    answer: "两列",
  } as const;
  const reply = send(human, explicit);
  expect(post(human, explicit).ok).toBe(false);
  const second = send(office, ask).id;
  const defaults = send(human, { action: "accept_defaults", group_id: second });
  send(office, ask); // no human reply to the third group
  const plan = send(office, { action: "propose" });
  expect(plan.body).toContain("按默认");
  const resolved = story().question_groups?.map((g) =>
    g.questions.map((q) => q.resolution),
  );
  expect(resolved).toEqual([
    [
      { source: "answer", value: "两列", entry_id: reply.id },
      { source: "proposal_default", value: "按时间", entry_id: plan.id },
    ],
    ["单列", "按时间"].map((value) => ({
      source: "accepted_default",
      value,
      entry_id: defaults.id,
    })),
    ["单列", "按时间"].map((value) => ({
      source: "proposal_default",
      value,
      entry_id: plan.id,
    })),
  ]);
  expect(storyDiscussionRounds(story())).toBe(2);
  expect(post(human, { action: "accept_defaults", group_id: first }).ok).toBe(
    false,
  );
  expect(f.state.cards.filter((c) => c.parent_card_id === f.parent.id)).toEqual(
    [],
  );
  expect(f.state.decisions).toEqual([]);
  expect(f.state.human_actions).toEqual([]);
  const child = f.create("general", f.parent.id);
  f.apply(f.done(child));
  f.apply(value(f.summary()));
  f.create("general", f.parent.id);
  expect(story().summary_entry_id).toBeUndefined();
  expect(storyDiscussionRounds(story())).toBe(2);
});

test("ordinary supersession cannot invalidate checklist or resolution evidence; replies and ordinary corrections still work", () => {
  const { f, office, send, story } = discussionFixture();
  const group = send(office, ask);
  const plain = (
    author: typeof human,
    link: { reply_to: typeof group.id } | { supersedes: typeof group.id },
  ) =>
    postComment(
      f.state,
      author,
      { card_id: f.parent.id, body: "补充说明", ...link },
      f.p,
    );
  const cannotReplace = (author: typeof human, entry: typeof group) =>
    expect(plain(author, { supersedes: entry.id })).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });

  cannotReplace(office, group);
  const reply = value(plain(office, { reply_to: group.id }));
  f.apply(reply);
  if (!reply.data) throw new Error("Missing reply");
  f.apply(value(plain(office, { supersedes: reply.data.id })));

  const answer = send(human, {
    action: "answer",
    group_id: group.id,
    number: 2,
    answer: "倒序",
  });
  cannotReplace(human, answer);
  const next = send(office, ask);
  const accepted = send(human, {
    action: "accept_defaults",
    group_id: next.id,
  });
  cannotReplace(human, accepted);
  const plan = send(office, { action: "propose" });
  cannotReplace(office, plan);
  expect(plan.body).toContain(`${group.id} 第 1 题按默认：单列`);
  expect(
    story().question_groups?.map((g) =>
      g.questions.map((q) => q.resolution?.entry_id),
    ),
  ).toEqual([
    [plan.id, answer.id],
    [accepted.id, accepted.id],
  ]);
  expect(storyDiscussionRounds(story())).toBe(2);
});

test("partial answer then accepting the remainder counts once and preserves the answer", () => {
  const { office, send, story } = discussionFixture();
  const group_id = send(office, ask).id;
  send(human, { action: "answer", group_id, number: 2, answer: "倒序" });
  send(human, { action: "accept_defaults", group_id });
  expect(
    story().question_groups?.[0]?.questions.map((q) => q.resolution?.value),
  ).toEqual(["单列", "倒序"]);
  expect(storyDiscussionRounds(story())).toBe(1);
});

test("discussion commands enforce same-story scope, author, open state and valid questions", () => {
  const { f, office, post, send } = discussionFixture();
  expect(post(human, ask).ok).toBe(false);
  expect(post(actor(3, "pm"), ask).ok).toBe(false);
  expect(post(office, { action: "ask", questions: [] }).ok).toBe(false);
  expect(
    post(office, {
      action: "ask",
      questions: [{ ...ask.questions[0], impact: " " }],
    }).ok,
  ).toBe(false);
  const group_id = send(office, ask).id,
    child = f.create("general", f.parent.id);
  const accept = { action: "accept_defaults", group_id } as const;
  expect(post(office, accept).ok).toBe(false);
  expect(post(human, accept, child.id).ok).toBe(false);
  expect(post(human, accept, f.create("story").id).ok).toBe(false);
  expect(
    post(human, { action: "answer", group_id, number: 0, answer: "x" }).ok,
  ).toBe(false);
  const opsState = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" as const } : a,
    ),
  };
  expect(
    postComment(
      opsState,
      office,
      { card_id: f.parent.id, body: "Ops", story_discussion: ask },
      f.p,
    ).ok,
  ).toBe(false);
  f.apply(f.done(f.parent));
  expect(post(human, accept).ok).toBe(false);
  expect(post(office, { action: "propose" }).ok).toBe(false);
});

test("Office uses the checklist for routine details, existing decision command for material story disagreements", () => {
  const { f, office } = discussionFixture();
  const request = (
    category: "scope_change" | "spending" | "credential" | "feature_detail",
    card_id = f.parent.id,
  ) =>
    requestDecision(
      f.state,
      office,
      {
        card_id,
        category,
        kind: "choose",
        decider: "human",
        plain_summary: {
          changed: "选择需求方向",
          impact: "确定工作范围",
          risk: "无",
        },
        question: "Which direction?",
        context: "Two options",
        options: [
          { key: "a", description: "Option A", impact: "Change scope" },
        ],
        recommended: "a",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
      },
      f.p,
    );
  for (const category of ["scope_change", "spending", "credential"] as const)
    expect(request(category).ok).toBe(true);
  expect(request("feature_detail").ok).toBe(false);
  expect(
    request("feature_detail", f.create("general", f.parent.id).id).ok,
  ).toBe(true);
});
