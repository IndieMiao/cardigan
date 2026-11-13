import { expect, test } from "vitest";
import type { Event } from "../entities.js";
import {
  attempt,
  CommandDraft,
  type CommandEntities,
  type CommandState,
  ensure,
} from "./core.js";
import { apply, human, now } from "./test-fixtures.js";

/**
 * C-230: `CommandDraft.get` uses a per-snapshot key index instead of
 * `list(collection).find(...)`. Every lookup here is compared with the former
 * linear implementation, across draft writes, new snapshots, event appends and
 * a rolled-back (discarded) draft.
 */
type Collection = "assignments" | "runs" | "card_templates" | "cursors";
const collections: readonly Collection[] = [
  "assignments",
  "runs",
  "card_templates",
  "cursors",
];

// The key `CommandDraft.list` deduplicates by (mirrors core.ts `keyOf`).
const keyOf = (entity: object): string => {
  const e = entity as Record<string, unknown>;
  return "version" in e
    ? `${e.id}@${e.version}`
    : "id" in e
      ? String(e.id)
      : `${e.assignment_id}/${e.card_id}`;
};

/** The pre-C-230 `get`, kept verbatim as the oracle. */
function legacyGet(d: CommandDraft, collection: Collection, id: string) {
  return attempt(() => {
    const entity = d.list(collection).find((value) => keyOf(value) === id);
    ensure(entity, "not_found", `${collection}:${id} was not found`);
    return entity;
  });
}

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

let serial = 0;
/** Distinct objects per call, so identity tells which duplicate won. */
function entity(collection: Collection, n: number): object {
  serial++;
  switch (collection) {
    case "assignments":
      return { id: `A-${n}`, status: "active", serial };
    case "runs":
      return { id: `R-${n}`, status: "queued", serial };
    case "card_templates":
      return { id: `T-${n % 3}`, version: n, serial };
    case "cursors":
      return { assignment_id: `A-${n % 3}`, card_id: `C-${n}`, serial };
  }
}
const keysOf = (collection: Collection, n: number) =>
  keyOf(entity(collection, n));

function randomState(seed: number): CommandState {
  const pick = rng(seed);
  const state: Record<string, unknown> = {
    project_id: human.project_id,
    roles: [],
    events: [],
    timeline: [],
    cards: [],
    work_items: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
  };
  for (const collection of collections) {
    // Sometimes leave optional collections out entirely.
    if (collection === "card_templates" && pick(4) === 0) continue;
    const list: object[] = [];
    // Duplicate keys: `list` keeps the last state entry per key.
    for (let i = 0, count = pick(12); i < count; i++)
      list.push(entity(collection, 1 + pick(8)));
    state[collection] = list;
  }
  return state as unknown as CommandState;
}

function expectSameLookups(d: CommandDraft, label: string) {
  for (const collection of collections)
    for (let n = 0; n <= 10; n++) {
      const id = keysOf(collection, n);
      const expected = legacyGet(d, collection, id);
      const actual = attempt(() => d.get(collection, id));
      expect(actual.ok, `${label} ${collection}:${id}`).toBe(expected.ok);
      if (actual.ok && expected.ok) expect(actual.value).toBe(expected.value);
      if (!actual.ok && !expected.ok)
        expect(actual.error).toEqual(expected.error);
    }
}

const draft = (state: CommandState) =>
  new CommandDraft(state, human, "create_card");

test("C-230: keyed CommandDraft.get matches list().find across writes, snapshots and rollback", () => {
  let hits = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const pick = rng(seed * 7919);
    const state = randomState(seed);
    const d = draft(state);
    expectSameLookups(d, `seed ${seed} initial`);

    // Writes inside the draft are read back immediately (write-then-read),
    // including replacing an earlier change for the same key.
    for (let step = 0, steps = 1 + pick(8); step < steps; step++) {
      const collection = collections[pick(collections.length)] as Collection;
      d.put(
        collection,
        entity(collection, 1 + pick(10)) as CommandEntities[Collection],
      );
      expectSameLookups(d, `seed ${seed} after put ${step}`);
    }
    // Appending events never changes entity lookups.
    d.events.push({
      id: `E-${seed}`,
      seq: 1,
      type: "comment_posted",
      actor: human,
      payload: {},
      created_at: now,
    } as unknown as Event);
    expectSameLookups(d, `seed ${seed} after event`);

    // Commit: a new snapshot (new arrays) is indexed afresh.
    const next = apply(state, {
      data: undefined,
      changes: d.changes,
      events: d.events,
      timeline: [],
      token_requests: [],
    });
    const committed = draft(next);
    expectSameLookups(committed, `seed ${seed} new snapshot`);
    for (const change of d.changes) {
      const id = keyOf(change.entity);
      expect(committed.get(change.collection as Collection, id)).toBe(
        change.entity,
      );
      hits++;
    }

    // Rollback: the discarded draft's writes are invisible to a new draft on
    // the old snapshot, whose index was built before the writes.
    const rolledBack = draft(state);
    expectSameLookups(rolledBack, `seed ${seed} rollback`);
    for (const change of d.changes) {
      const id = keyOf(change.entity);
      const before = attempt(() =>
        rolledBack.get(change.collection as Collection, id),
      );
      if (before.ok) expect(before.value).not.toBe(change.entity);
    }

    // A snapshot that only appends events reuses the entity arrays.
    const appended = draft({
      ...state,
      events: [...state.events, ...d.events],
    });
    expectSameLookups(appended, `seed ${seed} appended`);
  }
  expect(hits).toBeGreaterThan(300);
});

test("C-230: duplicate keys resolve to the last state entry, then the last change", () => {
  const first = { id: "A-1", status: "active", n: 1 };
  const second = { id: "A-1", status: "active", n: 2 };
  const state = {
    ...randomState(1),
    assignments: [first, { id: "A-2", status: "active" }, second],
  } as unknown as CommandState;
  const d = draft(state);
  expect(d.get("assignments", "A-1")).toBe(second);
  const changed = {
    ...second,
    n: 3,
  } as unknown as CommandEntities["assignments"];
  d.put("assignments", changed);
  expect(d.get("assignments", "A-1")).toBe(changed);
  const replaced = {
    ...second,
    n: 4,
  } as unknown as CommandEntities["assignments"];
  d.put("assignments", replaced);
  expect(d.get("assignments", "A-1")).toBe(replaced);
  // A second draft on the same snapshot does not see the first draft's writes.
  expect(draft(state).get("assignments", "A-1")).toBe(second);
});
