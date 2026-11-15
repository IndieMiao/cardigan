import {
  type CommandEffect,
  type CommandState,
  type Event,
  upgradeCardFlow,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import type { ReadRepositories } from "./repositories.js";
import { Store } from "./store.js";
import { card, project_id, withTempStore, workItem } from "./test-support.js";

const rawCard = (store: Store) =>
  store.database
    .prepare("SELECT doc FROM cards WHERE project_id = ? AND id = ?")
    .get(project_id, card().id)?.doc;
const state = (tx: ReadRepositories): CommandState => ({
  project_id,
  cards: tx.cards.list(project_id),
  work_items: tx.work_items.list(project_id),
  deliveries: tx.deliveries.list(project_id),
  decisions: [],
  assignments: [],
  roles: [],
  runs: [],
  reviews: [],
  human_actions: [],
  attachments: [],
  cursors: [],
  timeline: tx.timeline.list(project_id),
  events: tx.events.listAfter(project_id, card().id, 0),
});

test("legacy JSON reads as 1 through get, cached list, rollback and reopen without a migration or rewrite", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    store.uow.run((tx) => tx.cards.put(project_id, card()));
    const original = rawCard(store);
    const schema = store.schemaVersion();
    const read = () =>
      store.uow.read((tx) => ({
        get: tx.cards.get(project_id, card().id),
        list: tx.cards.list(project_id),
      }));
    const expected = { ...card(), flow_version: 1 };
    expect(read()).toEqual({ get: expected, list: [expected] });
    const before = read().list;
    expect(read().list).toBe(before);
    expect(() =>
      store.uow.run((tx) => {
        tx.cards.put(project_id, { ...card(), title: "Rolled back" });
        expect(tx.cards.list(project_id)[0]?.flow_version).toBe(1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(read().list).toBe(before);
    expect(rawCard(store)).toBe(original);
    const other = Store.open({ dataDir });
    try {
      expect(other.uow.read((tx) => tx.cards.list(project_id))).toEqual([
        expected,
      ]);
      other.uow.run((tx) =>
        tx.cards.put(project_id, { ...card(), title: "External legacy write" }),
      );
      expect(read().list[0]).toMatchObject({
        title: "External legacy write",
        flow_version: 1,
      });
      // Reads retain explicit versions; the command, not the persistence layer,
      // restricts newly chosen targets to shipped levels.
      other.uow.run((tx) =>
        tx.cards.put(project_id, { ...card(), flow_version: 2 }),
      );
      expect(read()).toEqual({
        get: { ...card(), flow_version: 2 },
        list: [{ ...card(), flow_version: 2 }],
      });
      expect(store.schemaVersion()).toBe(schema);
    } finally {
      other.close();
    }
  });
});

test("fresh write transactions reject a competing check and commit audit once after safe retry", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    store.uow.run((tx) => {
      tx.cards.put(project_id, card({ flow_version: 2 }));
      tx.work_items.put(project_id, workItem());
    });
    const other = Store.open({ dataDir });
    const human = { kind: "human" as const, project_id };
    const read = () => store.uow.read(state);
    const stale = read();
    const upgrade = () =>
      store.uow.run((tx) => {
        const result = upgradeCardFlow(
          state(tx),
          human,
          { card_id: card().id, to: 1 },
          { clock: { now: () => "2026-01-01T00:00:00.000Z" }, ids: tx.ids },
        );
        if (result.ok) {
          for (const change of result.value.changes) {
            expect(change.collection).toBe("cards");
            if (change.collection === "cards")
              tx.cards.put(project_id, change.entity);
          }
          for (const event of result.value.events)
            tx.events.append(project_id, event);
          for (const entry of result.value.timeline)
            tx.timeline.put(project_id, entry);
        }
        return result;
      });
    const event = (seq: number, status: string): Event => ({
      id: String(seq).padStart(26, "0") as Event["id"],
      seq,
      card_id: card().id,
      type: status === "queued" ? "merge_check_queued" : "merge_check_finished",
      actor: { kind: "system", project_id },
      payload: { attempt_id: "competing-check", status },
      created_at: "2026-01-01T00:00:00.000Z",
    });
    try {
      other.uow.run((tx) =>
        tx.events.append(
          project_id,
          event(tx.ids.nextEventSequence(project_id, card().id), "queued"),
        ),
      );
      expect(stale.events).toEqual([]);
      expect(upgrade()).toMatchObject({
        ok: false,
        error: { code: "illegal_transition" },
      });
      expect(read().cards[0]?.flow_version).toBe(2);
      expect(read().timeline).toEqual([]);
      other.uow.run((tx) =>
        tx.events.append(
          project_id,
          event(tx.ids.nextEventSequence(project_id, card().id), "passed"),
        ),
      );
      // A transaction that fails after writing the card must leave no partial audit.
      expect(() =>
        store.uow.run((tx) => {
          const result = upgradeCardFlow(
            state(tx),
            human,
            { card_id: card().id, to: 1 },
            { clock: { now: () => "2026-01-01T00:00:00.000Z" }, ids: tx.ids },
          );
          expect(result.ok).toBe(true);
          if (result.ok) tx.cards.put(project_id, result.value.data);
          throw new Error("fixture failure");
        }),
      ).toThrow("fixture failure");
      expect(read().cards[0]?.flow_version).toBe(2);
      expect(upgrade().ok).toBe(true);
      expect(upgrade()).toMatchObject({
        ok: true,
        value: { changes: [], events: [], timeline: [] },
      } satisfies Partial<{
        ok: boolean;
        value: Partial<CommandEffect<unknown>>;
      }>);
      expect(
        read().events.filter((e) => e.type === "card_flow_upgraded"),
      ).toHaveLength(1);
      expect(read().timeline).toHaveLength(1);
      expect(other.uow.read(state).cards[0]?.flow_version).toBe(1);
    } finally {
      other.close();
    }
  });
});
