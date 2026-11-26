/**
 * C-796: the dispatch journal reads the newest system record per attempt
 * from the Store log without decoding superseded or skipped dormant records.
 */
import { expect, test } from "vitest";
import {
  DISPATCH_RECORD_TYPES,
  dispatchHead,
  SKIP_ENTRY,
} from "./dispatch-records.js";
import type { Event } from "./entities.js";
import { DormantEvent, EventLog, EventLogView } from "./event-log.js";
import { githubRunCards, githubRunCardsIn } from "./hot-history.js";

const P = "P" as Event["actor"]["project_id"];
let serial = 0;
function record(
  card: string,
  seq: number,
  payload: Record<string, unknown>,
  kind: "system" | "human" = "system",
  type = "github_check_dispatch",
): Event {
  return {
    id: `e${++serial}` as Event["id"],
    seq,
    card_id: card as NonNullable<Event["card_id"]>,
    type,
    actor: { kind, project_id: P } as Event["actor"],
    payload: payload as Event["payload"],
    created_at: "2026-11-26T00:00:00.000Z",
  };
}

/** The journal's projection over decoded records (the pre-C-796 reader). */
function oracle(events: readonly Event[], type = "github_check_dispatch") {
  const out = new Map<string, Map<unknown, Event>>();
  for (const e of events) {
    if (e.type !== type || e.actor.kind !== "system") continue;
    const stream = e.card_id ?? "";
    let latest = out.get(stream);
    if (!latest) {
      latest = new Map();
      out.set(stream, latest);
    }
    latest.set((e.payload as { attempt?: unknown }).attempt, e);
  }
  return new Map([...out].map(([k, v]) => [k, [...v.values()]]));
}

const attemptKey = (entry: Event | DormantEvent) =>
  entry instanceof DormantEvent
    ? entry.dispatch?.system
      ? entry.dispatch.attempt
      : SKIP_ENTRY
    : entry.actor.kind === "system"
      ? (entry.payload as { attempt?: unknown }).attempt
      : SKIP_ENTRY;

function random(seed: number) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A log whose dormant rows are decided by `sleep`, plus an overlay. */
function build(
  events: readonly Event[],
  sleep: (e: Event) => boolean,
  split: number,
) {
  const byId = new Map(events.map((e) => [e.id, e]));
  let loads = 0;
  const loader = (stream: string, seqs: readonly number[]) => {
    loads += seqs.length;
    return seqs.map(
      (seq) =>
        [...byId.values()].find(
          (e) => (e.card_id ?? "") === stream && e.seq === seq,
        ) as Event,
    );
  };
  const base = new EventLog();
  base.loader = loader;
  for (const e of events.slice(0, split))
    if (sleep(e)) base.appendDormant(e);
    else base.append(e);
  const overlay = new EventLog(base.end);
  overlay.loader = loader;
  for (const e of events.slice(split)) overlay.append(e);
  const view = new EventLogView(base, base.end, overlay, overlay.end);
  return { view, base, loads: () => loads };
}

test("dormant dispatch records keep the head the journal keys and matches on", () => {
  const e = record("C-1", 1, {
    attempt: "a",
    finished: true,
    externalRun: { run_id: 42 },
    candidate: { repo: "r", ref: "x", sha: "s", delivery: "D" },
  });
  expect(dispatchHead(e)).toEqual({
    system: true,
    attempt: "a",
    run_id: "42",
    finished: true,
    repo: "r",
    ref: "x",
  });
  const log = new EventLog();
  log.appendDormant(e);
  log.appendDormant(record("C-1", 2, {}, "system", "comment_posted"));
  const [head, other] = [log.entryAt(0), log.entryAt(1)];
  expect(head instanceof DormantEvent && head.dispatch).toEqual(
    dispatchHead(e),
  );
  expect(other instanceof DormantEvent && other.dispatch).toBeUndefined();
  expect([...DISPATCH_RECORD_TYPES]).toEqual([
    "github_check_dispatch",
    "github_probe_dispatch",
  ]);
});

test.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "newestOfType equals the decoded projection and decodes only wanted newest records (seed %i)",
  (seed) => {
    const next = random(seed);
    const cards = ["C-1", "C-2", "C-3", "C-4"];
    const seqs = new Map<string, number>();
    const events: Event[] = [];
    for (let i = 0; i < 160; i++) {
      const card = cards[Math.floor(next() * cards.length)] as string;
      const seq = (seqs.get(card) ?? 0) + 1;
      seqs.set(card, seq);
      const r = next();
      const attempt =
        r < 0.05 ? undefined : r < 0.1 ? 7 : `a${Math.floor(next() * 6)}`;
      events.push(
        r < 0.15
          ? record(card, seq, { note: "x" }, "system", "comment_posted")
          : record(
              card,
              seq,
              {
                attempt,
                finished: next() < 0.5,
                ...(next() < 0.3
                  ? { externalRun: { run_id: 100 + Math.floor(next() * 5) } }
                  : {}),
              },
              next() < 0.1 ? "human" : "system",
            ),
      );
    }
    // Every dispatch record of C-2 and C-3 and odd seqs elsewhere sleep.
    const sleep = (e: Event) =>
      e.type === "github_check_dispatch" &&
      (e.card_id === "C-2" || e.card_id === "C-3" || e.seq % 2 === 1);
    const split = 120;
    const expected = oracle(events);

    const all = build(events, sleep, split);
    const got = all.view.newestOfType(
      "github_check_dispatch",
      attemptKey,
      () => true,
    );
    expect(new Map([...got].filter(([, v]) => v.length))).toEqual(expected);
    // Only newest records were decoded, at most one per attempt and stream.
    const newest = [...expected.values()].flat();
    expect(all.loads()).toBeLessThanOrEqual(newest.length);

    // Refusing every dormant newest record decodes nothing and leaves them out.
    const none = build(events, sleep, split);
    const kept = none.view.newestOfType(
      "github_check_dispatch",
      attemptKey,
      () => false,
    );
    expect(none.loads()).toBe(0);
    for (const [stream, list] of expected) {
      const decodedNewest = list.filter(
        (e) => !(sleep(e) && events.indexOf(e) < split),
      );
      expect(kept.get(stream) ?? []).toEqual(decodedNewest);
    }
    // One stream answers like the whole projection.
    const one = build(events, sleep, split).view.newestOfType(
      "github_check_dispatch",
      attemptKey,
      () => true,
      "C-2",
    );
    expect([...one.keys()]).toEqual(expected.has("C-2") ? ["C-2"] : []);
    expect(one.get("C-2") ?? []).toEqual(expected.get("C-2") ?? []);

    // Run-id lookups read dormant heads without decoding.
    const runs = build(events, sleep, split);
    for (const ids of [["100"], ["101", "104"], ["999"], ["x", "0"]]) {
      expect(githubRunCardsIn(runs.view, ids)).toEqual(
        githubRunCards(events, ids),
      );
    }
    expect(runs.loads()).toBe(0);
  },
);
