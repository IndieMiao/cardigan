import { createCard, markCardDone, updateCard } from "@cardigan/domain";
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
