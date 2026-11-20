import { expect, test } from "vitest";
import type { Card } from "../entities.js";
import { storyProgress } from "../story.js";
import { postComment } from "./coordination.js";
import type { CommandState } from "./core.js";
import { assign, createCard, updateCard } from "./pm.js";
import { markCardDone } from "./templates.js";
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
