import { describe, expect, test } from "vitest";
import type { Card, Event, WorkItem } from "../entities.js";
import type { EventId } from "../ids.js";
import type { Notification } from "../notification.js";
import { settledHumanActionNeedsYou } from "./card-close.js";
import { completeHumanAction, requestHumanAction } from "./coordination.js";
import type { CommandState } from "./core.js";
import { cancelHumanAction } from "./human-action-lifecycle.js";
import { createCard, updateCard } from "./pm.js";
import { listNeedsYou, listNeedsYouCounts } from "./queries.js";
import { markCardDone } from "./templates.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const pm = () => actor(4, "pm");
const io = ports();

function withCard(template_id: string) {
  const base: CommandState = { ...fixture(), cards: [], work_items: [] };
  const created = value(
    createCard(
      base,
      human,
      {
        template_id,
        title: "整理规则",
        goal: "写下规则",
        source: { kind: "quote", text: "请整理" },
      },
      io,
    ),
  );
  return { state: apply(base, created), card: created.data };
}

const requiredItem = (card: Card, status: WorkItem["status"]): WorkItem =>
  ({
    id: id("work_item", 80),
    card_id: card.id,
    kind: "produce",
    role_id: "coder",
    title: "做事",
    status,
    required: true,
    depends_on: [],
    completion_criteria: [],
  }) as WorkItem;

const toClose = (state: CommandState) =>
  value(listNeedsYou(state, human)).data.cards_to_close;
const markable = (state: CommandState, card: Card) =>
  markCardDone(state, human, { card_id: card.id, result: "完成" }, io).ok;

describe("C-750 待你标记完成", () => {
  test("listed once all required items pass, like markCardDone; gone when done", () => {
    const { state, card } = withCard("general");
    const open = { ...state, work_items: [requiredItem(card, "in_progress")] };
    expect(toClose(open)).toEqual([]);
    expect(markable(open, card)).toBe(false);

    const ready = { ...state, work_items: [requiredItem(card, "accepted")] };
    expect(markable(ready, card)).toBe(true);
    expect(toClose(ready)).toEqual([
      {
        card_id: card.id,
        card_title: "整理规则",
        template: "general",
        required_work_items: 1,
        close_request: null,
        since: null,
      },
    ]);
    // Re-reading never duplicates the entry.
    expect(toClose(ready)).toHaveLength(1);
    const counts = value(listNeedsYouCounts(ready, human)).data;
    expect(counts.total_pending).toBe(1);
    expect(counts.tabs.actions).toEqual({ count: 1, attention: 1 });
    expect(
      value(listNeedsYou(ready, human, undefined, { section: "decisions" }))
        .data.cards_to_close,
    ).toEqual([]);

    const done = apply(
      ready,
      value(
        markCardDone(ready, human, { card_id: card.id, result: "完成" }, io),
      ),
    );
    expect(toClose(done)).toEqual([]);
    const cancelled = {
      ...ready,
      cards: ready.cards.map((c) =>
        c.id === card.id ? { ...c, status: "cancelled" as const } : c,
      ),
    };
    expect(toClose(cancelled)).toEqual([]);
  });

  test("a held card or one with unmet prerequisites is not listed, as markCardDone refuses it", () => {
    const { state, card } = withCard("general");
    const ready = { ...state, work_items: [requiredItem(card, "accepted")] };
    for (const patch of [
      {
        hold: {
          reason: "等",
          resume_condition: "再说",
          set_by: "human",
          set_at: now,
        },
      },
      { depends_on_cards: [id("card", 99)] },
    ] as Partial<Card>[]) {
      const blocked = {
        ...ready,
        cards: [
          ...ready.cards.map((c) =>
            c.id === card.id ? { ...c, ...patch } : c,
          ),
          ...(patch.depends_on_cards
            ? [{ ...card, id: id("card", 99), status: "in_progress" as const }]
            : []),
        ],
      };
      expect(markable(blocked, card)).toBe(false);
      expect(toClose(blocked)).toEqual([]);
    }
  });

  test("review-completion and story cards are never listed", () => {
    const dev = fixture();
    expect(toClose(dev)).toEqual([]);
    const { state, card } = withCard("story");
    const decomposition = state.work_items.find((w) => w.card_id === card.id);
    expect(decomposition?.required).toBe(true);
    const finished: CommandState = {
      ...state,
      work_items: state.work_items.map((w) =>
        w.card_id === card.id ? ({ ...w, status: "accepted" } as WorkItem) : w,
      ),
    };
    expect(toClose(finished)).toEqual([]);
    expect(
      updateCard(
        finished,
        pm(),
        { card_id: card.id, close_request: { reason: "做完了" } },
        io,
      ).ok,
    ).toBe(false);
  });

  test("a card without required items is listed only after PM asks, with the reason", () => {
    const { state, card } = withCard("general");
    expect(toClose(state)).toEqual([]);
    const asked = value(
      updateCard(
        state,
        pm(),
        { card_id: card.id, close_request: { reason: " 规则已写进文档 " } },
        io,
      ),
    );
    expect(asked.events.map((e) => e.type)).toEqual(["card_close_requested"]);
    expect(asked.timeline[0]?.body).toBe("请所有者标记完成：规则已写进文档");
    const next = apply(state, asked);
    expect(toClose(next)).toEqual([
      {
        card_id: card.id,
        card_title: "整理规则",
        template: "general",
        required_work_items: 0,
        close_request: {
          reason: "规则已写进文档",
          set_by: "assignment:A-4",
          set_at: now,
        },
        since: now,
      },
    ]);
    // Same reason again is a no-op; asking never marks the card done.
    expect(
      value(
        updateCard(
          next,
          pm(),
          { card_id: card.id, close_request: { reason: "规则已写进文档" } },
          io,
        ),
      ).events,
    ).toEqual([]);
    expect(next.cards.find((c) => c.id === card.id)?.status).toBe(card.status);
    // Withdrawn → gone; marked done → gone.
    const withdrawn = apply(
      next,
      value(
        updateCard(next, pm(), { card_id: card.id, close_request: null }, io),
      ),
    );
    expect(toClose(withdrawn)).toEqual([]);
    const done = apply(
      next,
      value(
        markCardDone(next, human, { card_id: card.id, result: "完成" }, io),
      ),
    );
    expect(toClose(done)).toEqual([]);
  });

  test("PM's note rides on an already listed card", () => {
    const { state, card } = withCard("general");
    const ready = { ...state, work_items: [requiredItem(card, "accepted")] };
    const noted = apply(
      ready,
      value(
        updateCard(
          ready,
          pm(),
          { card_id: card.id, close_request: { reason: "验收已过" } },
          io,
        ),
      ),
    );
    expect(toClose(noted)).toMatchObject([
      {
        card_id: card.id,
        required_work_items: 1,
        close_request: { reason: "验收已过" },
      },
    ]);
  });

  test("PM may only ask for a closable card, with a reason, and not mixed with other edits", () => {
    const { state, card } = withCard("general");
    const unfinished = {
      ...state,
      work_items: [requiredItem(card, "in_progress")],
    };
    const refused = updateCard(
      unfinished,
      pm(),
      { card_id: card.id, close_request: { reason: "x" } },
      io,
    );
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain("必需工作项尚未全部完成");
    expect(
      updateCard(
        state,
        pm(),
        { card_id: card.id, close_request: { reason: " " } },
        io,
      ).ok,
    ).toBe(false);
    expect(
      updateCard(
        state,
        pm(),
        { card_id: card.id, title: "新", close_request: { reason: "x" } },
        io,
      ).ok,
    ).toBe(false);
    expect(
      updateCard(
        state,
        actor(1, "coder"),
        { card_id: card.id, close_request: { reason: "x" } },
        io,
      ).ok,
    ).toBe(false);
    // A dev card completes by review, not by the owner's mark.
    expect(
      updateCard(
        fixture(),
        pm(),
        { card_id: id("card", 1), close_request: { reason: "x" } },
        io,
      ).ok,
    ).toBe(false);
  });
});

describe("C-750 owner notices of settled human actions", () => {
  const request = (state: CommandState) =>
    value(
      requestHumanAction(
        state,
        human,
        {
          card_id: id("card", 1),
          instructions: "去后台点确认",
          why_human: "账号",
          expected_return: "已确认",
          blocked_work_items: [],
        },
        io,
      ),
    );
  const note = (
    event: Event,
    status: Notification["status"] = "pending",
  ): Notification => ({
    id: "N-1",
    project_id: human.project_id,
    event_id: event.id,
    recipient: { kind: "needs_you" },
    card_id: id("card", 1),
    seq: event.seq,
    kind: "needs_you",
    status,
    attempts: 0,
    created_at: now,
    updated_at: now,
  });

  test("resolved once the action is completed or cancelled, never while open", () => {
    const base = fixture();
    const requested = request(base);
    const state = apply(base, requested);
    const event = requested.events.find(
      (e) => e.type === "human_action_requested",
    );
    if (!event) throw new Error("missing request event");
    const action = requested.data.id;
    expect(settledHumanActionNeedsYou(state, note(event))).toBe(false);

    const completed = apply(
      state,
      value(
        completeHumanAction(
          state,
          human,
          { human_action_id: action, text: "已确认" },
          io,
        ),
      ),
    );
    expect(settledHumanActionNeedsYou(completed, note(event))).toBe(true);
    expect(settledHumanActionNeedsYou(completed, note(event, "belled"))).toBe(
      true,
    );
    // Terminal rows and other recipients are left alone.
    expect(settledHumanActionNeedsYou(completed, note(event, "resolved"))).toBe(
      false,
    );
    expect(
      settledHumanActionNeedsYou(completed, {
        ...note(event),
        recipient: { kind: "pm_ops" },
      }),
    ).toBe(false);

    const cancelled = apply(
      state,
      value(
        cancelHumanAction(
          state,
          human,
          { human_action_id: action, reason: "不需要了" },
          io,
        ),
      ),
    );
    expect(settledHumanActionNeedsYou(cancelled, note(event))).toBe(true);
  });

  test("reminders resolve only when every action they name is settled; unknown events stay", () => {
    const base = fixture();
    const first = request(base);
    let state = apply(base, first);
    const second = request(state);
    state = apply(state, second);
    const reminder = {
      ...(first.events[0] as Event),
      id: "E-reminder" as EventId,
      type: "pre_merge_check_reminder",
      payload: {
        reminders: [
          { human_action_id: first.data.id },
          { human_action_id: second.data.id },
        ],
      },
    } as Event;
    state = { ...state, events: [...state.events, reminder] };
    const done = apply(
      state,
      value(
        completeHumanAction(
          state,
          human,
          { human_action_id: first.data.id, text: "好了" },
          io,
        ),
      ),
    );
    expect(settledHumanActionNeedsYou(done, note(reminder))).toBe(false);
    const both = apply(
      done,
      value(
        completeHumanAction(
          done,
          human,
          { human_action_id: second.data.id, text: "好了" },
          io,
        ),
      ),
    );
    expect(settledHumanActionNeedsYou(both, note(reminder))).toBe(true);
    expect(
      settledHumanActionNeedsYou(both, {
        ...note(reminder),
        event_id: "E-missing" as EventId,
      }),
    ).toBe(false);
  });
});
