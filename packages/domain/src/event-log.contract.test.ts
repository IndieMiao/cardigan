import { expect, test, vi } from "vitest";
import { id, value } from "./commands/test-fixtures.js";
import type { Event, JsonValue } from "./entities.js";
import {
  appendEvents,
  cardEventsOfType,
  commandEventHistory,
  commandStreamHistory,
  eventById,
  eventsAtSeq,
  eventsForCompletion,
  eventsForDecision,
  eventsForHumanAction,
  eventsForWorkItem,
  eventsOfType,
  eventsOfTypes,
  fullEventHistory,
  isTelemetryEvent,
  resumeEventsForItem,
  streamEvents,
  telemetryEvents,
} from "./event-index.js";
import {
  type EventIndexKind,
  EventLog,
  EventLogView,
  type HistoryFilter,
  type IndexKeys,
  indexKeysOf,
  streamHistory,
} from "./event-log.js";
import type { CardId } from "./ids.js";
import { parseEventId } from "./index.js";
import { streamEventsBy } from "./stream-events.js";

const eventId = (n: number) =>
  value(parseEventId(n.toString().padStart(26, "0")));
const cards = [1, 2, 3, 4].map((n) => id("card", n));
const types = ["run_started", "decision_requested", "__proto__", "noise"];

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

/** Random events in commit order with per-stream ascending seq. */
function randomBatch(
  pick: (n: number) => number,
  seqs: Map<string, number>,
  next: { id: number },
  count: number,
): Event[] {
  return Array.from({ length: count }, () => {
    const stream = pick(5);
    const card_id = stream ? cards[stream - 1] : undefined;
    const key = card_id ?? "";
    const seq = (seqs.get(key) ?? 0) + 1;
    seqs.set(key, seq);
    const payloads: JsonValue[] = [
      null,
      { decision_id: `Q-${pick(3)}` },
      { human_action_id: `H-${pick(3)}`, decision_id: `Q-${pick(3)}` },
      { completion_id: `CR-${pick(3)}`, work_item_id: `W-${pick(3)}` },
      { resume_work_items: [`W-${pick(3)}`, `W-${pick(3)}`, 7] },
      { decision_id: 3, human_action_id: 4, work_item_id: ["W-1"] },
      ["Q-1"],
    ];
    return {
      id: eventId(next.id++),
      seq,
      ...(card_id ? { card_id } : {}),
      type: types[pick(types.length)] as string,
      actor: { kind: "system", project_id: "fixture-project" },
      payload: payloads[pick(payloads.length)] as JsonValue,
      created_at: "2026-01-01T00:00:00.000Z",
    };
  });
}

/** Linear reference: the legacy `["", ...cards].flatMap(streams.get)` history. */
function legacyHistory(all: readonly Event[], order: readonly string[]) {
  return order.flatMap((stream) =>
    all
      .filter((e) => (e.card_id ?? "") === stream)
      .sort((a, b) => a.seq - b.seq),
  );
}

function expectSameLookups(
  indexed: readonly Event[],
  copy: readonly Event[],
  sameArray = true,
) {
  if (sameArray) expect(indexed).toEqual(copy);
  for (const type of [...types, "absent"]) {
    expect(eventsOfType(indexed, type)).toEqual(eventsOfType(copy, type));
    for (const card of ["", ...cards, id("card", 9)])
      expect(cardEventsOfType(indexed, card, type)).toEqual(
        cardEventsOfType(copy, card, type),
      );
  }
  for (let n = 0; n < 4; n++) {
    expect(eventsForDecision(indexed, `Q-${n}`)).toEqual(
      eventsForDecision(copy, `Q-${n}`),
    );
    expect(eventsForHumanAction(indexed, `H-${n}`)).toEqual(
      eventsForHumanAction(copy, `H-${n}`),
    );
    expect(eventsForCompletion(indexed, `CR-${n}`)).toEqual(
      eventsForCompletion(copy, `CR-${n}`),
    );
    expect(eventsForWorkItem(indexed, `W-${n}`)).toEqual(
      eventsForWorkItem(copy, `W-${n}`),
    );
    expect(resumeEventsForItem(indexed, `W-${n}`)).toEqual(
      resumeEventsForItem(copy, `W-${n}`),
    );
  }
  for (let n = 0; n < 80; n++)
    expect(eventById(indexed, eventId(n))).toBe(eventById(copy, eventId(n)));
  expect(eventById(indexed, undefined)).toBeUndefined();
}

/** C-649: multi-type, per-stream and per-seq lookups equal the plain filters. */
function expectGroupLookups(indexed: readonly Event[], copy: readonly Event[]) {
  expect(indexed).toEqual(copy);
  for (const set of [
    ["run_started", "noise"],
    ["noise", "run_started", "noise"],
    ["decision_requested", "__proto__", "absent"],
    ["absent"],
    [],
  ]) {
    const expected = copy.filter((e) => set.includes(e.type));
    expect(eventsOfTypes(indexed, set)).toEqual(expected);
    expect(eventsOfTypes(copy, set)).toEqual(expected);
  }
  for (const card of [undefined, ...cards, id("card", 9)]) {
    const stream = copy.filter((e) => (e.card_id ?? "") === (card ?? ""));
    expect(streamEvents(indexed, card)).toEqual(stream);
    expect(streamEvents(copy, card)).toEqual(stream);
    for (const seq of new Set([0, ...stream.map((e) => e.seq), 99])) {
      const at = stream.filter((e) => e.seq === seq);
      expect(eventsAtSeq(indexed, card, seq)).toEqual(at);
      expect(eventsAtSeq(copy, card, seq)).toEqual(at);
    }
  }
}

test("C-640: log views and indexes match the legacy history and per-array scans", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const pick = rng(seed);
    const seqs = new Map<string, number>();
    const next = { id: 1 };
    const log = new EventLog();
    const committed: Event[] = [];
    const views: { view: EventLogView; all: readonly Event[] }[] = [];
    for (let round = 0; round < 4; round++) {
      // A transaction overlay: visible to its own views, published on commit.
      const overlay = new EventLog(log.end);
      const added = randomBatch(pick, seqs, next, pick(12));
      for (const event of added) overlay.append(event);
      const view = new EventLogView(log, log.end, overlay, overlay.end);
      const all = [...committed, ...added];
      views.push({ view, all });
      if (pick(3) === 0) {
        // ROLLBACK: drop the overlay; reuse its seqs/ids later.
        for (const event of added) {
          const key = event.card_id ?? "";
          seqs.set(key, (seqs.get(key) ?? 0) - 1);
        }
        next.id -= added.length;
        continue;
      }
      for (const event of overlay.all) log.append(event);
      committed.push(...added);
    }
    views.push({ view: new EventLogView(log, log.end), all: [...committed] });
    // Every view, including rolled-back and pre-commit ones, keeps its contents.
    for (const { view, all } of views) {
      const order = pick(2)
        ? ["", ...cards]
        : ["", cards[2] as string, cards[0] as string];
      const history = view.history(order);
      expect(view.history([...order])).toBe(history);
      expect(streamHistory(view, order)).toBe(history);
      expectSameLookups(history, legacyHistory(all, order));
      for (const stream of ["", ...cards]) {
        const expected = legacyHistory(all, [stream]);
        expect(view.get(stream) ?? []).toEqual(expected);
        expect(view.has(stream)).toBe(expected.length > 0);
      }
      expect(new Map(view)).toEqual(
        new Map(
          [...view.keys()].map((key) => [key, legacyHistory(all, [key])]),
        ),
      );
      expect(view.size).toBe(new Set(all.map((e) => e.card_id ?? "")).size);
      // appendEvents reuses the base index and indexes only the tail.
      const tail = randomBatch(pick, new Map(seqs), { id: 1000 }, 3);
      const appended = appendEvents(history, tail);
      expectSameLookups(appended, [...history, ...tail]);
      expectSameLookups(appendEvents(appended, tail), [
        ...history,
        ...tail,
        ...tail,
      ]);
    }
  }
});

test("C-640: appending never copies or re-sorts a stream and unchanged streams keep identity", () => {
  const log = new EventLog();
  const seqs = new Map<string, number>();
  const next = { id: 1 };
  const pick = rng(7);
  for (const event of randomBatch(pick, seqs, next, 200)) log.append(event);
  const first = new EventLogView(log, log.end);
  const before = new Map([...first.keys()].map((k) => [k, first.get(k)]));
  const segments = new Map(log.streams);
  const sort = vi.spyOn(Array.prototype, "sort");
  const slice = vi.spyOn(Array.prototype, "slice");
  try {
    const event: Event = {
      id: eventId(next.id++),
      seq: (seqs.get(cards[0] as string) ?? 0) + 1,
      card_id: cards[0] as NonNullable<Event["card_id"]>,
      type: "noise",
      actor: { kind: "system", project_id: "fixture-project" },
      payload: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    log.append(event);
    expect(sort).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    // Storage grows in place; no segment was replaced.
    for (const [key, seg] of segments) expect(log.streams.get(key)).toBe(seg);
    const second = new EventLogView(log, log.end);
    for (const [key, events] of before)
      if (key !== cards[0]) expect(second.get(key)).toBe(events);
    expect(second.get(cards[0] as string)?.at(-1)).toBe(event);
    // The earlier view and its arrays are unchanged.
    expect(first.get(cards[0] as string)).toBe(before.get(cards[0] as string));
    expect(first.get(cards[0] as string)).not.toContain(event);
    expect(eventById(first.history(["", ...cards]), event.id)).toBeUndefined();
  } finally {
    sort.mockRestore();
    slice.mockRestore();
  }
});

test("C-640: a dropped overlay never leaks into later views or reused ordinals", () => {
  const event = (n: number, type: string, card?: string): Event => ({
    id: eventId(n),
    seq: n,
    ...(card ? { card_id: card as NonNullable<Event["card_id"]> } : {}),
    type,
    actor: { kind: "system", project_id: "fixture-project" },
    payload: { decision_id: "Q-1" },
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const log = new EventLog();
  log.append(event(1, "base"));
  const order = ["", cards[0] as string];
  const rolledBack = new EventLog(log.end);
  rolledBack.append(event(2, "secret", cards[0]));
  const stale = new EventLogView(log, log.end, rolledBack, rolledBack.end);
  const staleHistory = stale.history(order);
  expect(eventsOfType(staleHistory, "secret")).toHaveLength(1);
  // ROLLBACK drops the overlay; the next transaction reuses ordinal 1.
  const fresh = new EventLogView(log, log.end);
  const history = fresh.history(order);
  expect(eventsOfType(history, "secret")).toEqual([]);
  expect(eventsForDecision(history, "Q-1").map((e) => e.type)).toEqual([
    "base",
  ]);
  expect(eventById(history, eventId(2))).toBeUndefined();
  const committed = new EventLog(log.end);
  committed.append(event(3, "public", cards[0]));
  for (const e of committed.all) log.append(e);
  const after = new EventLogView(log, log.end).history(order);
  expect(eventsOfType(after, "secret")).toEqual([]);
  expect(eventsOfType(after, "public")).toHaveLength(1);
  // The stale view still answers only for its own snapshot.
  expect(eventsOfType(stale.history(order), "public")).toEqual([]);
  expect(eventsOfType(staleHistory, "secret")).toHaveLength(1);
  expect(eventsOfType(history, "public")).toEqual([]);
});

test("C-639: filtered history and its index match the plain filter; ofTypes matches per-stream grouping", () => {
  const omit = new Set(["run_started", "__proto__"]);
  for (let seed = 1; seed <= 80; seed++) {
    const pick = rng(seed);
    const seqs = new Map<string, number>();
    const next = { id: 1 };
    const log = new EventLog();
    const committed: Event[] = [];
    for (let round = 0; round < 4; round++) {
      const overlay = new EventLog(log.end);
      const added = randomBatch(pick, seqs, next, pick(14));
      for (const event of added) overlay.append(event);
      const all = [...committed, ...added];
      const views = [
        { view: new EventLogView(log, log.end, overlay, overlay.end), all },
        { view: new EventLogView(log, log.end), all: [...committed] },
      ];
      for (const { view, all: events } of views) {
        const full = new Set(cards.filter(() => pick(2) === 0));
        const filter = { full, omit };
        const order = ["", ...cards];
        const expected = legacyHistory(events, order).filter(
          (e) => !e.card_id || full.has(e.card_id) || !omit.has(e.type),
        );
        const history = view.history(order, filter);
        expect(view.history(order, { full: new Set(full), omit })).toBe(
          history,
        );
        expect(streamHistory(view, order, filter)).toBe(history);
        expectSameLookups(history, expected);
        // A plain map (no Store log) gives the same events.
        expect(streamHistory(new Map(view), order, filter)).toEqual(expected);
        // Unfiltered history of the same view is unaffected.
        expectSameLookups(view.history(order), legacyHistory(events, order));
        const tail = randomBatch(pick, new Map(seqs), { id: 1000 }, 3);
        expectSameLookups(appendEvents(history, tail), [...expected, ...tail]);
        for (const set of [
          new Set(["run_started"]),
          new Set(["noise", "decision_requested"]),
          new Set(["absent"]),
        ]) {
          const grouped = new Map<string, Event[]>();
          for (const stream of view.keys()) {
            const kept = (view.get(stream) ?? []).filter((e) =>
              set.has(e.type),
            );
            if (kept.length) grouped.set(stream, kept);
          }
          const subset = view.ofTypes(set);
          expect(view.ofTypes(new Set(set))).toBe(subset);
          expect(new Map(subset)).toEqual(grouped);
        }
      }
      if (pick(3) === 0) {
        for (const event of added) {
          const key = event.card_id ?? "";
          seqs.set(key, (seqs.get(key) ?? 0) - 1);
        }
        next.id -= added.length;
        continue;
      }
      for (const event of overlay.all) log.append(event);
      committed.push(...added);
    }
  }
});

test("C-639: a stream moving between full and filtered never reuses the other's answers", () => {
  const event = (n: number, type: string, card?: string): Event => ({
    id: eventId(n),
    seq: n,
    ...(card ? { card_id: card as NonNullable<Event["card_id"]> } : {}),
    type,
    actor: { kind: "system", project_id: "fixture-project" },
    payload: { work_item_id: "W-1" },
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const card = cards[0] as string;
  const log = new EventLog();
  log.append(event(1, "run_started", card));
  log.append(event(2, "card_merged", card));
  const order = ["", card];
  const omit = new Set(["run_started"]);
  const view = new EventLogView(log, log.end);
  const cold = view.history(order, { full: new Set(), omit });
  expect(cold.map((e) => e.type)).toEqual(["card_merged"]);
  expect(eventsForWorkItem(cold, "W-1")).toHaveLength(1);
  expect(eventsOfType(cold, "run_started")).toEqual([]);
  expect(cardEventsOfType(cold, card, "run_started")).toEqual([]);
  expect(eventById(cold, eventId(1))).toBeUndefined();
  const hot = new EventLogView(log, log.end).history(order, {
    full: new Set([card]),
    omit,
  });
  expect(eventsForWorkItem(hot, "W-1")).toHaveLength(2);
  expect(eventsOfType(hot, "run_started")).toHaveLength(1);
  // Back to cold on a later view: the shared answers follow the filter.
  const again = new EventLogView(log, log.end).history(order, {
    full: new Set(),
    omit,
  });
  expect(eventsForWorkItem(again, "W-1")).toHaveLength(1);
  expect(eventById(again, eventId(1))).toBeUndefined();
});

test("C-643: the Store command stream drops telemetry but answers every lookup over the (hot) history", () => {
  // `types` includes run_started (telemetry) and noise (business); the C-639
  // filter may trim either from cold streams.
  for (let seed = 1; seed <= 60; seed++) {
    const pick = rng(seed);
    const seqs = new Map<string, number>();
    const next = { id: 1 };
    const log = new EventLog();
    const committed: Event[] = [];
    for (let round = 0; round < 3; round++) {
      const overlay = new EventLog(log.end);
      const added = randomBatch(pick, seqs, next, pick(12));
      for (const event of added) overlay.append(event);
      const view = new EventLogView(log, log.end, overlay, overlay.end);
      const all = [...committed, ...added];
      const order = pick(2)
        ? ["", ...cards]
        : ["", cards[2] as string, cards[0] as string];
      const filters: (HistoryFilter | undefined)[] = [
        undefined,
        {
          full: new Set(cards.filter(() => pick(2) === 0)),
          omit: new Set(["run_started", "noise"]),
        },
      ];
      for (const filter of filters) {
        const kept = (stream: string) =>
          legacyHistory(all, [stream]).filter(
            (e) =>
              !filter ||
              stream === "" ||
              filter.full.has(stream) ||
              !filter.omit.has(e.type),
          );
        const full = order.flatMap(kept);
        const history = vi.spyOn(view, "history");
        const events = commandStreamHistory(view, order, filter);
        expect(commandStreamHistory(view, [...order], filter)).toBe(events);
        expect(events).toEqual(full.filter((e) => !isTelemetryEvent(e)));
        // Lookups come from the shared index, without materializing the history.
        expectSameLookups(events, full, false);
        expect(history).not.toHaveBeenCalled();
        history.mockRestore();
        expect(telemetryEvents(events)).toEqual(full.filter(isTelemetryEvent));
        expect(fullEventHistory(events)).toBe(view.history(order, filter));
        // Maps without the Store log split their streams with the same answers.
        const split = commandEventHistory(order.map(kept));
        expect(split).toEqual(events);
        expect(telemetryEvents(split)).toEqual(telemetryEvents(events));
        expectSameLookups(split, full, false);
        const plain = commandStreamHistory(new Map(view), order, filter);
        expect(plain).toEqual(events);
        expect(fullEventHistory(plain)).toEqual(full);
        // Draft histories keep the journal and see telemetry emitted in the tail.
        const tail = randomBatch(pick, new Map(seqs), { id: 1000 }, 3);
        for (const base of [events, split]) {
          const appended = appendEvents(base, tail);
          expect(appended).toEqual([...base, ...tail]);
          expectSameLookups(appended, [...full, ...tail], false);
          expect(fullEventHistory(appended)).toEqual([...full, ...tail]);
          expect(telemetryEvents(appended)).toEqual(
            [...full, ...tail].filter(isTelemetryEvent),
          );
        }
      }
      if (pick(3) === 0) {
        for (const event of added) {
          const key = event.card_id ?? "";
          seqs.set(key, (seqs.get(key) ?? 0) - 1);
        }
        next.id -= added.length;
        continue;
      }
      for (const event of overlay.all) log.append(event);
      committed.push(...added);
    }
  }
});

test("C-649: multi-type, stream and seq lookups match plain filters on full, filtered and appended histories", () => {
  const omit = new Set(["run_started", "__proto__"]);
  for (let seed = 1; seed <= 40; seed++) {
    const pick = rng(seed);
    const seqs = new Map<string, number>();
    const next = { id: 1 };
    const log = new EventLog();
    const committed: Event[] = [];
    for (let round = 0; round < 3; round++) {
      const overlay = new EventLog(log.end);
      const added = randomBatch(pick, seqs, next, pick(14));
      for (const event of added) overlay.append(event);
      const all = [...committed, ...added];
      const order = ["", ...cards.slice(0, 3)];
      for (const { view, events } of [
        {
          view: new EventLogView(log, log.end, overlay, overlay.end),
          events: all,
        },
        { view: new EventLogView(log, log.end), events: [...committed] },
      ]) {
        expectGroupLookups(view.history(order), legacyHistory(events, order));
        const full = new Set(cards.filter(() => pick(2) === 0));
        const expected = legacyHistory(events, order).filter(
          (e) => !e.card_id || full.has(e.card_id) || !omit.has(e.type),
        );
        const history = view.history(order, { full, omit });
        expectGroupLookups(history, expected);
        const tail = randomBatch(pick, new Map(seqs), { id: 1000 }, 3);
        expectGroupLookups(appendEvents(history, tail), [...expected, ...tail]);
        // Project-stream retention by id: history and every lookup agree.
        const dropped = new Set(
          events.filter((e) => !e.card_id && pick(2) === 0).map((e) => e.id),
        );
        const retained = expected.filter((e) => !dropped.has(e.id));
        const kept = view.history(order, { full, omit, dropped });
        expect(view.history(order, { full, omit, dropped })).toBe(kept);
        expectGroupLookups(kept, retained);
        expectSameLookups(kept, retained);
        expect(
          streamHistory(new Map(view), order, { full, omit, dropped }),
        ).toEqual(retained);
      }
      for (const event of overlay.all) log.append(event);
      committed.push(...added);
    }
  }
});

test("C-649: histories with different dropped sets never share index answers", () => {
  const log = new EventLog();
  const at = "2026-01-01T00:00:00.000Z";
  const actor = { kind: "system", project_id: "fixture-project" } as const;
  const p = (n: number): Event => ({
    id: eventId(n),
    seq: n,
    type: "noise",
    actor,
    payload: { decision_id: "Q-1" },
    created_at: at,
  });
  for (const n of [1, 2, 3]) log.append(p(n));
  const order = [""];
  const omit = new Set<string>();
  const full = new Set<string>();
  const ids = (events: readonly Event[]) => events.map((e) => e.seq);
  const first = new EventLogView(log, log.end).history(order, {
    full,
    omit,
    dropped: new Set([eventId(1)]),
  });
  expect(ids(eventsOfType(first, "noise"))).toEqual([2, 3]);
  expect(ids(eventsForDecision(first, "Q-1"))).toEqual([2, 3]);
  const second = new EventLogView(log, log.end).history(order, {
    full,
    omit,
    dropped: new Set([eventId(2)]),
  });
  expect(ids(eventsOfType(second, "noise"))).toEqual([1, 3]);
  expect(ids(eventsForDecision(second, "Q-1"))).toEqual([1, 3]);
  const none = new EventLogView(log, log.end).history(order, {
    full,
    omit,
    dropped: new Set(),
  });
  expect(ids(eventsOfType(none, "noise"))).toEqual([1, 2, 3]);
});

/** Independent oracle: the callers' former `listAfter(...).filter` scans. */
function legacyMatch(event: Event, kind: EventIndexKind, key: unknown) {
  const p = event.payload as Record<string, unknown> | null;
  if (kind === "type") return event.type === key;
  if (kind === "resume_work_items")
    return (
      Array.isArray(p?.resume_work_items) && p.resume_work_items.includes(key)
    );
  return typeof key === "string" && p?.[kind] === key;
}

test("C-652: matching and streamEventsBy equal filtering the stream read", () => {
  const selections: [EventIndexKind, IndexKeys][] = [
    ["type", ["run_started"]],
    ["type", ["noise", "__proto__", "noise"]],
    ["type", ["absent"]],
    ["type", []],
    ["type", (key) => typeof key === "string" && key.startsWith("d")],
    ["decision_id", ["Q-0", "Q-2"]],
    ["decision_id", [3]],
    ["completion_id", ["CR-1"]],
    ["work_item_id", ["W-1"]],
    ["resume_work_items", ["W-0", "W-1"]],
    ["resume_work_items", [7]],
    ["resume_work_items", () => true],
  ];
  for (let seed = 1; seed <= 60; seed++) {
    const pick = rng(seed);
    const seqs = new Map<string, number>();
    const next = { id: 1 };
    const log = new EventLog();
    for (const event of randomBatch(pick, seqs, next, pick(40)))
      log.append(event);
    const overlay = new EventLog(log.end);
    for (const event of randomBatch(pick, seqs, next, pick(12)))
      overlay.append(event);
    // A committed head, an overlay view and a stale view behind later appends.
    const stale = new EventLogView(log, log.end);
    const views = [stale, new EventLogView(log, log.end, overlay, overlay.end)];
    for (const event of randomBatch(pick, seqs, next, pick(6)))
      log.append(event);
    views.push(new EventLogView(log, log.end));
    for (const view of views)
      for (const stream of ["", ...cards, id("card", 9)])
        for (const [kind, keys] of selections) {
          const match = (e: Event) =>
            typeof keys === "function"
              ? indexKeysOf(e, kind).some(keys)
              : keys.some((key) => legacyMatch(e, kind, key));
          const expected = view.after(stream, 0).filter(match);
          const actual = view.matching(stream, kind, keys);
          expect(actual).toEqual(expected);
          if (actual.length)
            expect(view.matching(stream, kind, keys)).not.toBe(actual);
          const card = (stream || undefined) as CardId | undefined;
          const reader = (streams?: ReadonlyMap<string, readonly Event[]>) => ({
            listAfter: (_: string, c: CardId | undefined, since: number) =>
              view.after(c ?? "", since),
            ...(streams ? { listStreams: () => streams } : {}),
          });
          // Store view, a reader without listStreams and a plain map agree.
          expect(streamEventsBy(reader(view), "P", card, kind, keys)).toEqual(
            expected,
          );
          expect(streamEventsBy(reader(), "P", card, kind, keys)).toEqual(
            expected,
          );
          expect(
            streamEventsBy(reader(new Map(view)), "P", card, kind, keys),
          ).toEqual(expected);
        }
  }
});
