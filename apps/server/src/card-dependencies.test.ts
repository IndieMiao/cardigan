import {
  type CardId,
  createCard,
  markCardDone,
  updateCard,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemRules } from "./system-rules.js";
import { readCardsPage } from "./web/cards-page.js";
import { readPagedCard } from "./web/timeline-state.js";

function setup() {
  const f = m3Fixture();
  const predecessor = f.apply((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Before",
        goal: "Before",
        source: { kind: "quote", text: "Before" },
        template: "general",
      },
      p,
    ),
  ).data;
  f.apply((s, a, p) =>
    updateCard(
      s,
      a,
      {
        card_id: f.card.id,
        status: "backlog",
        depends_on_cards: [predecessor.id],
        wait_for_dependencies: true,
      },
      p,
    ),
  );
  return { f, predecessor };
}

test("system sweep releases only explicit waiters and persists one PM notification across replay", async () => {
  const { f, predecessor } = setup();
  try {
    runSystemRules(f.store, f.id, f.clock);
    expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
      "backlog",
    );
    f.apply((s, a, p) =>
      markCardDone(s, a, { card_id: predecessor.id, result: "Complete" }, p),
    );
    runSystemRules(f.store, f.id, f.clock);
    await routeProjectEvents(f.store, f.id, f.clock);
    const once = f
      .state()
      .events.filter((e) => e.type === "card_dependencies_released");
    expect(once).toHaveLength(1);
    expect(f.state().cards.find((c) => c.id === f.card.id)).toMatchObject({
      status: "todo",
      wait_for_dependencies: false,
    });
    runSystemRules(f.store, f.id, f.clock);
    await routeProjectEvents(f.store, f.id, f.clock);
    expect(
      f.state().events.filter((e) => e.type === "card_dependencies_released"),
    ).toEqual(once);
    const notes = f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === once[0]?.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.recipient).toMatchObject({ kind: "pm_ops" });
  } finally {
    f.close();
  }
});

test("paged detail and board use predecessor evidence outside the requested page", () => {
  const { f, predecessor } = setup();
  try {
    const detail = () =>
      readPagedCard(
        f.store,
        f.id,
        f.card.id,
        new URL("http://fixture/card?limit=1"),
        {},
      );
    expect(detail()?.card.dependency?.waiting_on).toEqual([predecessor.id]);
    f.apply((s, a, p) =>
      markCardDone(s, a, { card_id: predecessor.id, result: "Complete" }, p),
    );
    expect(detail()?.card.dependency?.predecessors).toEqual([
      expect.objectContaining({
        id: predecessor.id,
        status: "done",
        satisfied: true,
      }),
    ]);
    expect(detail()?.card.dependency?.waiting_on).toEqual([]);
    const page = readCardsPage(
      f.store,
      f.id,
      new URL(`http://fixture/cards?limit=1&q=${f.card.id}`),
    );
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]?.dependency?.waiting_on).toEqual([]);
    const before = readPagedCard(
      f.store,
      f.id,
      predecessor.id,
      new URL("http://fixture/card"),
      {},
    );
    expect(before?.card.dependency?.successors.map((c) => c.id)).toContain(
      f.card.id,
    );
  } finally {
    f.close();
  }
});

test("completion preview uses the same off-page prerequisite evidence as the dependency panel", () => {
  const { f, predecessor } = setup();
  try {
    const dependent = f.apply((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "Manual result",
          goal: "Complete after prerequisite",
          source: { kind: "quote", text: "Complete after prerequisite" },
          template: "general",
          depends_on_cards: [predecessor.id],
        },
        p,
      ),
    ).data;
    const detail = () =>
      readPagedCard(
        f.store,
        f.id,
        dependent.id,
        new URL("http://fixture/card?limit=1"),
        {},
      );
    expect(detail()?.mark_done).toMatchObject({ allowed: false });
    expect(detail()?.card.dependency?.waiting_on).toEqual([predecessor.id]);
    f.apply((s, a, p) =>
      markCardDone(s, a, { card_id: predecessor.id, result: "Complete" }, p),
    );
    expect(detail()?.card.dependency?.waiting_on).toEqual([]);
    expect(detail()?.mark_done).toMatchObject({ allowed: true, reason: null });
  } finally {
    f.close();
  }
});

test("C-487 detail graph carries the whole upstream and downstream chain without bystanders", () => {
  const { f, predecessor } = setup();
  try {
    const create = (title: string, depends_on_cards?: CardId[]) =>
      f.apply((s, a, p) =>
        createCard(
          s,
          a,
          {
            title,
            goal: title,
            source: { kind: "quote", text: title },
            template: "general",
            ...(depends_on_cards ? { depends_on_cards } : {}),
          },
          p,
        ),
      ).data;
    const root = create("Root");
    f.apply((s, a, p) =>
      updateCard(
        s,
        a,
        { card_id: predecessor.id, depends_on_cards: [root.id] },
        p,
      ),
    );
    const after = create("After", [f.card.id]);
    const last = create("Last", [after.id, root.id]);
    const bystander = create("Bystander", [root.id]);
    f.apply((s, a, p) =>
      markCardDone(s, a, { card_id: root.id, result: "Complete" }, p),
    );
    const dependency = readPagedCard(
      f.store,
      f.id,
      f.card.id,
      new URL("http://fixture/card?limit=1"),
      {},
    )?.card.dependency;
    const graph =
      dependency && "graph" in dependency ? dependency.graph : undefined;
    expect(graph?.nodes.map((n) => n.id).sort()).toEqual(
      [root.id, predecessor.id, f.card.id, after.id, last.id].sort(),
    );
    expect(graph?.nodes.find((n) => n.id === root.id)).toMatchObject({
      status: "done",
      satisfied: true,
    });
    expect(graph?.nodes.find((n) => n.id === f.card.id)).toMatchObject({
      title: f.card.title,
      satisfied: false,
    });
    expect(graph?.edges).toEqual(
      expect.arrayContaining([
        { from: root.id, to: predecessor.id },
        { from: predecessor.id, to: f.card.id },
        { from: f.card.id, to: after.id },
        { from: after.id, to: last.id },
        { from: root.id, to: last.id },
      ]),
    );
    expect(graph?.edges).toHaveLength(5);
    expect(graph?.nodes.map((n) => n.id)).not.toContain(bystander.id);
    // Board rows stay small: only the open detail carries the graph.
    const page = readCardsPage(
      f.store,
      f.id,
      new URL(`http://fixture/cards?limit=1&q=${f.card.id}`),
    );
    expect(page.cards[0]?.dependency).not.toHaveProperty("graph");
  } finally {
    f.close();
  }
});

test("C-487 graph nodes show the derived status the card detail shows", () => {
  const { f } = setup();
  try {
    const after = f.apply((s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "After",
          goal: "After",
          source: { kind: "quote", text: "After" },
          template: "general",
          depends_on_cards: [f.card.id],
        },
        p,
      ),
    ).data;
    const stored = f.state().cards.find((c) => c.id === f.card.id);
    const produce = f
      .state()
      .work_items.find(
        (w) => w.card_id === f.card.id && w.kind === "produce" && w.required,
      );
    if (!produce) throw new Error("fixture card has no required produce item");
    f.store.uow.run((tx) => {
      tx.cards.put(f.id, { ...stored, status: "todo" } as never);
      tx.work_items.put(f.id, { ...produce, status: "delivered" } as never);
    });
    const read = (id: CardId) =>
      readPagedCard(
        f.store,
        f.id,
        id,
        new URL("http://fixture/card?limit=1"),
        {},
      )?.card;
    const detail = read(f.card.id);
    expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
      "todo",
    );
    expect(detail?.status).toBe("review");
    const graphOf = (card: typeof detail) =>
      card?.dependency && "graph" in card.dependency
        ? card.dependency.graph
        : undefined;
    expect(
      graphOf(detail)?.nodes.find((n) => n.id === f.card.id),
    ).toMatchObject({ status: "review", satisfied: false });
    expect(
      graphOf(read(after.id))?.nodes.find((n) => n.id === f.card.id),
    ).toMatchObject({ status: "review", satisfied: false });
  } finally {
    f.close();
  }
});

test.each(["full", "summary"])(
  "%s board rows preserve dependency waits and early start outside the requested page",
  (view) => {
    const { f, predecessor } = setup();
    try {
      const boardCard = () => {
        const page = readCardsPage(
          f.store,
          f.id,
          new URL(
            `http://fixture/cards?filter=all&view=${view}&mode=board&limit=1&q=${f.card.id}`,
          ),
        );
        expect(page.cards).toHaveLength(1);
        return page.cards[0];
      };
      expect(boardCard()?.dependency?.waiting_on).toEqual([predecessor.id]);
      expect(boardCard()).not.toHaveProperty("early_start");
      const early = f.apply((s, a, p) =>
        updateCard(
          s,
          a,
          {
            card_id: f.card.id,
            early_start: true,
            dependency_reason: "Parallel work",
            status: "todo",
          },
          p,
        ),
      ).data.early_start;
      expect(boardCard()).toMatchObject({
        early_start: early,
        dependency: { waiting_on: [predecessor.id] },
      });
      f.apply((s, a, p) =>
        markCardDone(s, a, { card_id: predecessor.id, result: "Complete" }, p),
      );
      expect(boardCard()).toMatchObject({
        early_start: early,
        dependency: { waiting_on: [] },
      });
      f.apply((s, a, p) =>
        updateCard(
          s,
          a,
          {
            card_id: f.card.id,
            depends_on_cards: [],
            early_start: false,
            dependency_reason: "Dependency cleared",
          },
          p,
        ),
      );
      expect(boardCard()).not.toHaveProperty("dependency");
      expect(boardCard()).not.toHaveProperty("early_start");
    } finally {
      f.close();
    }
  },
);

test("linked and overdue framework reminders each reach PM Ops once; normal completion ends the wait", () => {
  const { f, predecessor } = setup();
  try {
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: predecessor.id, is_ui_framework: true }, p),
    );
    const sweep = () =>
      runSystemRules(f.store, f.id, f.clock, undefined, undefined, {
        frameworkWaitReminderMs: 1000,
      });
    f.advance(1000);
    sweep();
    expect(
      f.state().events.some((e) => e.type === "framework_dependency_overdue"),
    ).toBe(false);
    f.advance(1);
    sweep();
    sweep();
    routeProjectEvents(f.store, f.id, { clock: f.clock });
    routeProjectEvents(f.store, f.id, { clock: f.clock });
    for (const type of [
      "framework_dependency_linked",
      "framework_dependency_overdue",
    ]) {
      const events = f.state().events.filter((e) => e.type === type);
      expect(events).toHaveLength(1);
      const notes = f.store
        .listNotifications({ project_id: f.id })
        .filter((n) => n.event_id === events[0]?.id);
      expect(notes).toMatchObject([
        { recipient: { kind: "pm_ops" }, card_id: f.card.id },
      ]);
      const entry = f
        .state()
        .timeline.find(
          (t) => t.card_id === f.card.id && t.event_seq === notes[0]?.seq,
        );
      expect(entry?.body).toContain(predecessor.id);
      expect(entry?.body).toContain(f.card.id);
    }
    // A new wait which completes before its deadline must not generate another reminder.
    for (const flag of [false, true])
      f.apply((s, a, p) =>
        updateCard(s, a, { card_id: predecessor.id, is_ui_framework: flag }, p),
      );
    f.apply((s, a, p) =>
      markCardDone(
        s,
        a,
        { card_id: predecessor.id, result: "Merged layout" },
        p,
      ),
    );
    f.advance(1001);
    sweep();
    expect(
      f.state().events.filter((e) => e.type === "framework_dependency_overdue"),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
