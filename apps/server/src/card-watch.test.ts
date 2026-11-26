import {
  CARD_WATCH_ENDED,
  CARD_WATCH_TRIGGERED,
  createCard,
  markCardDone,
  updateCard,
  watchCard,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemRules } from "./system-rules.js";

test("C-763: a registered watch rings PM Ops once through the Store, across replays", async () => {
  const f = m3Fixture();
  try {
    const other = (title: string) =>
      f.apply((s, a, p) =>
        createCard(
          s,
          a,
          {
            title,
            goal: title,
            source: { kind: "quote", text: title },
            template: "general",
          },
          p,
        ),
      ).data;
    const target = other("Target");
    const dropped = other("Dropped");
    for (const card_id of [target.id, dropped.id])
      f.apply((s, a, p) =>
        watchCard(
          s,
          a,
          { card_id, until: "done", context_card_id: f.card.id },
          p,
        ),
      );
    const before = f.state();
    runSystemRules(f.store, f.id, f.clock);
    await routeProjectEvents(f.store, f.id, f.clock);
    const settlements = () =>
      f
        .state()
        .events.filter((e) =>
          [CARD_WATCH_TRIGGERED, CARD_WATCH_ENDED].includes(e.type),
        );
    expect(settlements()).toEqual([]);
    expect(f.state().cards).toEqual(before.cards);
    expect(f.state().work_items).toEqual(before.work_items);

    f.apply((s, a, p) =>
      markCardDone(s, a, { card_id: target.id, result: "Complete" }, p),
    );
    f.apply((s, a, p) =>
      updateCard(s, a, { card_id: dropped.id, status: "cancelled" }, p),
    );
    for (let i = 0; i < 2; i++) {
      runSystemRules(f.store, f.id, f.clock);
      await routeProjectEvents(f.store, f.id, f.clock);
    }
    const fired = settlements();
    expect(fired.map((e) => [e.type, e.card_id])).toEqual([
      [CARD_WATCH_TRIGGERED, f.card.id],
      [CARD_WATCH_ENDED, f.card.id],
    ]);
    for (const e of fired) {
      const notes = f.store
        .listNotifications({ project_id: f.id })
        .filter((n) => n.event_id === e.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.recipient).toMatchObject({ kind: "pm_ops" });
    }
    // Neither watched card nor the waiting card was changed by the watch.
    expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
      before.cards.find((c) => c.id === f.card.id)?.status,
    );
  } finally {
    f.close();
  }
});
