import { describe, expect, test } from "vitest";
import {
  CARD_WATCH_ENDED,
  CARD_WATCH_OPEN_LIMIT,
  CARD_WATCH_REGISTERED,
  CARD_WATCH_TRIGGERED,
  openCardWatches,
} from "../card-watch.js";
import type { Card, Event } from "../entities.js";
import { parseEventId } from "../ids.js";
import {
  cardWatchesPending,
  settleCardWatches,
  type WatchCardInput,
  watchCard,
} from "./card-watch.js";
import { postComment } from "./coordination.js";
import type { CommandState } from "./core.js";
import { updateCard } from "./pm.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const opsPm = actor(4, "pm"); // standing PM
const cardPm = actor(3, "pm"); // work-item PM on C-1
const C1 = id("card", 1);
const C2 = id("card", 2);

const watch = (
  state: CommandState,
  input: Partial<WatchCardInput> = {},
  who = opsPm,
) =>
  watchCard(
    state,
    who,
    { card_id: C2, until: "done", context_card_id: C1, ...input },
    ports(),
  );
const withCard = (state: CommandState, patch: Partial<Card>, n = 2) => ({
  ...state,
  cards: state.cards.map((c) =>
    c.id === id("card", n) ? { ...c, ...patch } : c,
  ),
});
const settle = (state: CommandState) =>
  value(settleCardWatches(state, system, ports()));
const merged = (card_id = C2): Event => ({
  id: value(parseEventId(`7${"9".repeat(25)}`)),
  card_id,
  seq: 99,
  type: "card_merged",
  actor: system,
  payload: { card_id },
  created_at: now,
});
function registered(input: Partial<WatchCardInput> = {}, who = opsPm) {
  const state = fixture();
  const effect = value(watch(state, input, who));
  return { state: apply(state, effect), effect };
}

describe("C-763 registering a card watch", () => {
  test("standing PM registers on any same-project card without changing either card", () => {
    const state = fixture();
    const effect = value(watch(state, { note: "等 C-2 合入四个提交" }));
    expect(effect.changes).toEqual([]);
    expect(effect.data).toMatchObject({
      created: true,
      target_card_id: C2,
      until: "done",
      recipient: { kind: "assignment", assignment_id: id("assignment", 4) },
      posted_on: C1,
    });
    expect(effect.events).toMatchObject([
      {
        type: CARD_WATCH_REGISTERED,
        card_id: C1,
        actor: opsPm,
        payload: {
          target_card_id: C2,
          until: "done",
          context_card_id: C1,
          note: "等 C-2 合入四个提交",
        },
      },
    ]);
    expect(effect.timeline[0]).toMatchObject({
      card_id: C1,
      type: "system",
      refs: [{ kind: "card", id: C2 }],
    });
    const after = apply(state, effect);
    for (const key of [
      "cards",
      "work_items",
      "runs",
      "assignments",
      "deliveries",
      "reviews",
      "decisions",
      "human_actions",
    ] as const)
      expect(after[key]).toEqual(state[key]);
    expect(openCardWatches(after.events, human.project_id)).toMatchObject([
      { id: effect.data.watch_id, registered_at: now },
    ]);
  });

  test("a work-item PM defaults to its own card; PM Ops inbox and human registration", () => {
    const own = value(
      watchCard(fixture(), cardPm, { card_id: C2, until: "merged" }, ports()),
    );
    expect(own.data).toMatchObject({
      posted_on: C1,
      recipient: { kind: "assignment", assignment_id: id("assignment", 3) },
    });
    expect(own.events[0]?.payload).toMatchObject({ context_card_id: C1 });
    const inbox = value(watch(fixture(), { notify: "pm_ops" }));
    expect(inbox.data.recipient).toEqual({ kind: "pm_ops" });
    const byHuman = value(
      watchCard(fixture(), human, { card_id: C2, until: "cancelled" }, ports()),
    );
    expect(byHuman.data).toMatchObject({
      recipient: { kind: "pm_ops" },
      posted_on: C2,
    });
  });

  test.each<[string, (s: CommandState) => ReturnType<typeof watch>, string]>([
    [
      "missing target card",
      (s) => watch(s, { card_id: id("card", 9) }),
      "not_found",
    ],
    [
      "target card of another project",
      (s) =>
        watch(
          { ...s, cards: [...s.cards, { ...card(7), project_id: "other" }] },
          { card_id: id("card", 7) },
        ),
      "unauthorized",
    ],
    ["non-PM caller", (s) => watch(s, {}, actor(1, "coder")), "forbidden_tool"],
    [
      "already closed target",
      (s) => watch(withCard(s, { status: "done" })),
      "validation_failed",
    ],
    [
      "watching its own card",
      (s) => watchCard(s, cardPm, { card_id: C1, until: "done" }, ports()),
      "validation_failed",
    ],
    [
      "work-item PM posting on another card",
      (s) => watch(s, { card_id: C1, context_card_id: C2 }, cardPm),
      "unauthorized",
    ],
    [
      "human asking to ring itself",
      (s) => watch(s, { notify: "self" }, human),
      "validation_failed",
    ],
    [
      "unknown state",
      (s) => watch(s, { until: "review" as never }),
      "validation_failed",
    ],
    [
      "control characters in the note",
      (s) => watch(s, { note: "a\u0007b" }),
      "validation_failed",
    ],
  ])("rejects %s", (_name, run, code) => {
    const result = run(fixture());
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  test("the same open watch is returned, not registered twice; open watches are capped", () => {
    const { state, effect } = registered();
    const again = value(watch(state));
    expect(again.data).toMatchObject({
      created: false,
      watch_id: effect.data.watch_id,
    });
    expect(again.events).toEqual([]);
    let crowded = fixture();
    crowded = {
      ...crowded,
      cards: [
        ...crowded.cards,
        ...Array.from({ length: CARD_WATCH_OPEN_LIMIT + 1 }, (_, i) =>
          card(10 + i),
        ),
      ],
    };
    for (let i = 0; i < CARD_WATCH_OPEN_LIMIT; i++)
      crowded = apply(
        crowded,
        value(watch(crowded, { card_id: id("card", 10 + i) })),
      );
    expect(
      watch(crowded, { card_id: id("card", 10 + CARD_WATCH_OPEN_LIMIT) }),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    // Another recipient keeps its own allowance.
    expect(
      watch(crowded, {
        card_id: id("card", 10 + CARD_WATCH_OPEN_LIMIT),
        notify: "pm_ops",
      }).ok,
    ).toBe(true);
  });
});

describe("C-763 settling a card watch", () => {
  test("does not ring while the target has not reached the state", () => {
    const { state } = registered();
    for (const status of ["in_progress", "review", "awaiting_merge"] as const) {
      const open = withCard(state, { status });
      expect(cardWatchesPending(open)).toBe(false);
      expect(settle(open).events).toEqual([]);
    }
    expect(settle(fixture()).events).toEqual([]);
  });

  test("rings once with the cause and registration time when the target is done", () => {
    const { state, effect } = registered({ note: "等它确认" });
    const done = withCard(state, { status: "done" });
    expect(cardWatchesPending(done)).toBe(true);
    const fired = settle(done);
    expect(fired.changes).toEqual([]);
    expect(fired.events).toMatchObject([
      {
        type: CARD_WATCH_TRIGGERED,
        card_id: C1,
        actor: system,
        payload: {
          watch_id: effect.data.watch_id,
          target_card_id: C2,
          until: "done",
          recipient: { kind: "assignment", assignment_id: id("assignment", 4) },
          registered_by: "assignment:A-4",
          registered_at: now,
          target_status: "done",
        },
      },
    ]);
    const notice = (fired.events[0]?.payload as { notice?: string } | undefined)
      ?.notice;
    expect(notice).toContain("C-2 已完成");
    expect(notice).toContain(now);
    expect(notice).toContain("等它确认");
    expect(fired.timeline[0]).toMatchObject({ card_id: C1, author: "system" });
    // Replaying the pass, now or after another status change, rings no more.
    const after = apply(done, fired);
    expect(cardWatchesPending(after)).toBe(false);
    expect(settle(after).events).toEqual([]);
    expect(
      settle(withCard(after, { resolution: "superseded" })).events,
    ).toEqual([]);
    expect(openCardWatches(after.events, human.project_id)).toEqual([]);
  });

  test("a merge watch rings on the trusted merge record, not on an assignment's claim", () => {
    const { state } = registered({ until: "merged" });
    const claimed = {
      ...state,
      events: [...state.events, { ...merged(), actor: opsPm }],
    };
    expect(
      settle(withCard(claimed, { status: "awaiting_merge" })).events,
    ).toEqual([]);
    const fact = merged();
    const fired = settle({ ...state, events: [...state.events, fact] });
    expect(fired.events).toMatchObject([
      {
        type: CARD_WATCH_TRIGGERED,
        payload: { until: "merged", evidence_event_id: fact.id },
      },
    ]);
  });

  test.each<[string, Partial<WatchCardInput>, Partial<Card>, string]>([
    ["cancelled before done", {}, { status: "cancelled" }, "cancelled"],
    [
      "superseded",
      {},
      {
        status: "cancelled",
        resolution: "superseded",
        superseded_by: id("card", 3),
      },
      "superseded",
    ],
    [
      "done as superseded",
      {},
      {
        status: "done",
        resolution: "superseded",
        superseded_by: id("card", 3),
      },
      "superseded",
    ],
    [
      "done without a merge",
      { until: "merged" },
      { status: "done" },
      "done_without_merge",
    ],
    [
      "done while waiting for cancel",
      { until: "cancelled" },
      { status: "done" },
      "done",
    ],
  ])(
    "tells the registrant when the target closes another way: %s",
    (_n, input, patch, reason) => {
      const { state, effect } = registered(input);
      const closed = withCard(state, patch);
      const ended = settle(closed);
      expect(ended.events).toMatchObject([
        {
          type: CARD_WATCH_ENDED,
          card_id: C1,
          payload: {
            watch_id: effect.data.watch_id,
            reason,
            target_status: patch.status,
            ...(patch.superseded_by
              ? { superseded_by: patch.superseded_by }
              : {}),
          },
        },
      ]);
      expect(
        (ended.events[0]?.payload as { notice?: string } | undefined)?.notice,
      ).toContain("观察结束");
      expect(settle(apply(closed, ended)).events).toEqual([]);
    },
  );

  test("a cancel watch is reached by cancellation, superseded or not", () => {
    for (const patch of [
      { status: "cancelled" as const },
      { status: "cancelled" as const, resolution: "superseded" as const },
    ]) {
      const { state } = registered({ until: "cancelled" });
      expect(settle(withCard(state, patch)).events).toMatchObject([
        { type: CARD_WATCH_TRIGGERED, payload: { target_status: "cancelled" } },
      ]);
    }
  });

  test("an untrusted settlement claim does not consume the watch", () => {
    const { state, effect } = registered();
    const forged: Event = {
      id: value(parseEventId(`7${"8".repeat(25)}`)),
      card_id: C1,
      seq: 98,
      type: CARD_WATCH_TRIGGERED,
      actor: opsPm,
      payload: { watch_id: effect.data.watch_id },
      created_at: now,
    };
    const done = withCard(
      { ...state, events: [...state.events, forged] },
      { status: "done" },
    );
    expect(settle(done).events).toHaveLength(1);
  });

  test("only the system may settle watches", () => {
    const { state } = registered();
    expect(
      settleCardWatches(withCard(state, { status: "done" }), opsPm, ports()),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});

describe("C-763 regression: a watch never blocks or locks either card", () => {
  test("both cards accept the same operations before and after registration", () => {
    const before = fixture();
    const { state: after } = registered();
    const operations = [
      (s: CommandState) =>
        updateCard(s, opsPm, { card_id: C2, priority: 3 }, ports()),
      (s: CommandState) =>
        updateCard(s, opsPm, { card_id: C1, priority: 3 }, ports()),
      (s: CommandState) =>
        postComment(s, actor(1), { card_id: C1, body: "继续推进" }, ports()),
      (s: CommandState) => watch(s, { card_id: C1, context_card_id: C2 }),
    ];
    for (const operation of operations) {
      const a = operation(before);
      const b = operation(after);
      expect(a.ok, "before registration").toBe(true);
      expect(b.ok, "after registration").toBe(true);
      if (a.ok && b.ok) expect(b.value.changes).toEqual(a.value.changes);
    }
    for (const c of after.cards) expect(c.status).toBe("in_progress");
    for (const w of after.work_items)
      expect(w.status).toBe(
        before.work_items.find((x) => x.id === w.id)?.status,
      );
  });
});
