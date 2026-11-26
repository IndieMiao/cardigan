/**
 * C-796: the Store keeps superseded dispatch records, and retired newest
 * records of closed cards, dormant; the journal reads each attempt's newest
 * record only. Every answer about unfinished executors must equal the
 * whole-history reader's, and one attempt still never gets two executors.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardId, Event, ProjectId } from "@cardigan/domain";
import { Store, type StoreTransactionContext } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { fixture } from "../../domain/src/commands/test-fixtures.js";
import {
  type GithubDispatchIntent,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";

const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const P = "fixture-project" as ProjectId;
const Q = "other-project" as ProjectId;
const OPEN = "C-1" as CardId;
const CLOSED = "C-2" as CardId;
const STALE = "C-3" as CardId;
const AT = "2030-01-01T00:00:00Z";
const REPO = "fixture/project";
const base = (
  project: ProjectId,
  card: CardId,
  attempt: string,
): GithubDispatchIntent => ({
  project,
  card,
  attempt,
  key: `key-${attempt}`,
  startedAt: AT,
  executor: "github",
  phase: "reserved",
  candidate: {
    repo: REPO,
    ref: `refs/heads/ci/${card}/D-1/${attempt}`,
    sha: "a".repeat(40),
    delivery: "D-1",
  },
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-retention-"));
  roots.push(root);
  const dbPath = join(root, "test.db");
  const open = (commandState: "full" | "hot" | "lean" | "slim") => {
    const store = Store.open({ dbPath, commandState });
    stores.push(store);
    return store;
  };
  const writer = open("full");
  const card = fixture().cards[0];
  if (!card) throw new Error("missing fixture");
  for (const project of [P, Q]) writer.createProject({ id: project });
  writer.uow.run((tx) => {
    tx.cards.put(P, { ...card, id: OPEN, status: "awaiting_merge" });
    tx.cards.put(P, { ...card, id: CLOSED, status: "done" });
    tx.cards.put(P, { ...card, id: STALE, status: "cancelled" });
    tx.cards.put(Q, { ...card, id: CLOSED, status: "done" });
  });
  const append = (
    intent: GithubDispatchIntent,
    actor: "system" | "human" = "system",
  ) =>
    writer.uow.run((tx: StoreTransactionContext) =>
      tx.events.append(
        intent.project as ProjectId,
        {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(
            intent.project as ProjectId,
            intent.card as CardId,
          ),
          card_id: intent.card as CardId,
          type: "github_check_dispatch",
          actor: { kind: actor, project_id: intent.project } as Event["actor"],
          payload: JSON.parse(JSON.stringify(intent)),
          created_at: AT,
        } as Event,
      ),
    );
  /** Several saves per attempt, like the journal's own lifecycle. */
  const lifecycle = (intent: GithubDispatchIntent, end: object) => {
    append(intent);
    append({ ...intent, phase: "publishing" });
    append({ ...intent, phase: "dispatching", dispatchedRunId: 9 });
    append({ ...intent, phase: "dispatching", ...end });
  };
  // Open card: one live dispatch, one cleaned-up attempt.
  lifecycle(base(P, OPEN, "o-live"), {});
  lifecycle(base(P, OPEN, "o-done"), { finished: true, deleted: true });
  // Closed card: retired attempts (cleaned up; no candidate), an ambiguous
  // abandoned dispatch that is NOT finished (unknown remote state), and a
  // finished one whose branch is not cleaned up yet.
  lifecycle(base(P, CLOSED, "c-deleted"), { finished: true, deleted: true });
  const { candidate: _drop, ...noCandidate } = base(P, CLOSED, "c-bare");
  lifecycle(noCandidate, { finished: true });
  lifecycle(base(P, CLOSED, "c-unknown"), {
    abandoned: "superseded",
    abandonmentReason: "interrupted",
  });
  lifecycle(base(P, CLOSED, "c-kept"), {
    finished: true,
    externalRun: { run_id: 77 },
  });
  // A non-system record never supersedes the newest system record.
  append({ ...base(P, CLOSED, "c-unknown"), finished: true }, "human");
  // Cancelled card: a timed-out reservation still holding the executor.
  lifecycle(base(P, STALE, "s-timeout"), { nextDiscoveryAt: 1 });
  // Another project, same card id: a retired intent on the same repo.
  lifecycle(base(Q, CLOSED, "q-deleted"), { finished: true, deleted: true });

  const journal = (store: Store) => new GithubDispatchJournal(store);
  /** The pre-C-796 reader: whole card streams, nothing dormant. */
  const oracle = () =>
    writer.uow.read((tx) =>
      journal(writer).allAt({
        ...tx,
        events: { listAfter: tx.events.listAfter },
      }),
    );
  const dormant = (store: Store, project = P) =>
    store.uow.read((tx) => {
      const view = tx.events.listStreams?.(project);
      if (!view || !("base" in view)) throw new Error("missing log view");
      return view.base.dormant;
    });
  return { open, writer, append, lifecycle, journal, oracle, dormant };
}
const attempts = (intents: readonly GithubDispatchIntent[]) =>
  intents.map((i) => `${i.project}/${i.card}/${i.attempt}`);
const RETIRED = new Set([
  `${P}/${CLOSED}/c-deleted`,
  `${P}/${CLOSED}/c-bare`,
  `${Q}/${CLOSED}/q-deleted`,
]);

test.each(["hot", "lean", "slim"] as const)(
  "%s: unfinished executors equal the whole-history reader and no superseded record is decoded",
  (scope) => {
    const f = setup();
    const store = f.open(scope);
    const j = f.journal(store);
    const oracle = f.oracle();
    // 8 attempts x 3 superseded saves, plus 3 retired newest records.
    const sleeping = f.dormant(store) + f.dormant(store, Q);
    expect(sleeping).toBe(8 * 3 + 3);
    store.uow.read((tx) => {
      const all = j.allAt(tx);
      // Only retired intents of closed cards are left out, in the same order.
      expect(all).toEqual(
        oracle.filter(
          (i) => !RETIRED.has(`${i.project}/${i.card}/${i.attempt}`),
        ),
      );
      expect(j.unfinishedExecutorsAt(tx)).toEqual(
        oracle.filter((i) => !i.finished).map((i) => i.executor),
      );
    });
    expect(attempts(j.unfinished())).toEqual(
      attempts(oracle.filter((i) => !i.finished)),
    );
    // Timed-out, interrupted and unknown states remain unfinished.
    expect(attempts(j.unfinished())).toEqual([
      `${P}/${OPEN}/o-live`,
      `${P}/${CLOSED}/c-unknown`,
      `${P}/${STALE}/s-timeout`,
    ]);
    expect(attempts(j.admitted())).toEqual(attempts(j.unfinished()));
    // None of these reads decoded a dormant record.
    expect(f.dormant(store) + f.dormant(store, Q)).toBe(sleeping);
  },
);

test("one attempt never gets a second executor, also on closed cards and after restart", () => {
  const f = setup();
  for (const store of [f.writer, f.open("hot")]) {
    const j = f.journal(store);
    // Unfinished intents on closed cards still hold executor capacity
    // (first, before any per-card read decodes those cards' records).
    expect(() => j.claim(base(Q, CLOSED, "q-next"), 3)).toThrow("card_busy");
    const unknown = base(P, CLOSED, "c-unknown");
    // Same attempt, different trusted inputs: refused; so is the abandoned
    // ambiguous dispatch itself, which only recovery may take up.
    expect(() => j.claim({ ...unknown, key: "forged" })).toThrow("security");
    expect(() => j.claim(unknown)).toThrow("security");
    // Same attempt, same inputs: the existing intent, never a fresh one.
    expect(j.claim(base(P, STALE, "s-timeout")).fresh).toBe(false);
    // Another attempt on a card with an unfinished intent: busy.
    expect(() => j.claim(base(P, CLOSED, "c-new"))).toThrow("card_busy");
    expect(() => j.claim(base(P, STALE, "s-new"))).toThrow("card_busy");
    // A retired attempt is never reused (its record is dormant on hot).
    expect(() => j.claim(base(P, CLOSED, "c-deleted"))).toThrow("security");
    expect(() =>
      j.claim({ ...base(P, CLOSED, "c-bare"), candidate: undefined }),
    ).toThrow("security");
  }
});

test("candidate fences see retired intents of every project; a reopened card is read whole again", () => {
  const f = setup();
  const store = f.open("hot");
  const j = f.journal(store);
  const sleeping = f.dormant(store, Q);
  // Q's retired intent owns this exact ref: a new claim in P is refused.
  const ref = base(Q, CLOSED, "q-deleted").candidate;
  if (!ref) throw new Error("missing candidate");
  const twin = { ...base(P, OPEN, "o-twin"), candidate: ref };
  expect(() => f.journal(f.writer).claim(twin)).toThrow("security");
  expect(() => j.claim(twin)).toThrow("security");
  store.uow.read((tx) =>
    expect(attempts(j.candidateOwnersAt(tx, ref))).toEqual([
      `${Q}/${CLOSED}/q-deleted`,
    ]),
  );
  // Only the matching newest record was decoded.
  expect(f.dormant(store, Q)).toBe(sleeping - 1);

  // Reopening the card brings its retired intents back, as stored.
  f.writer.uow.run((tx) => {
    const card = tx.cards.get(P, CLOSED);
    if (card) tx.cards.put(P, { ...card, status: "in_progress" });
  });
  expect(f.journal(store).all()).toEqual(f.oracle());
});

test("writes after the first read and other connections are seen whole; rollback leaves nothing", () => {
  const f = setup();
  const store = f.open("hot");
  const j = f.journal(store);
  const before = j.all();
  store.uow.read((tx) => {
    expect(j.allAt(tx)).toEqual(before);
    // Another connection finishes the unknown dispatch mid-read: this read
    // keeps its snapshot, never a half-applied state.
    f.append({
      ...base(P, CLOSED, "c-unknown"),
      finished: true,
      deleted: true,
    });
    expect(j.allAt(tx)).toEqual(before);
  });
  expect(attempts(j.unfinished())).toEqual([
    `${P}/${OPEN}/o-live`,
    `${P}/${STALE}/s-timeout`,
  ]);
  // A newer record of a retired attempt is decoded and supersedes it.
  f.append({
    ...base(P, CLOSED, "c-deleted"),
    finished: true,
    deleted: true,
    abandonmentReason: "again",
  });
  expect(
    j.all().find((i) => i.attempt === "c-deleted")?.abandonmentReason,
  ).toBe("again");
  expect(() =>
    store.uow.run((tx) => {
      tx.events.append(P, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(P, OPEN),
        card_id: OPEN,
        type: "github_check_dispatch",
        actor: { kind: "system", project_id: P },
        payload: JSON.parse(
          JSON.stringify({ ...base(P, OPEN, "o-live"), finished: true }),
        ),
        created_at: AT,
      });
      expect(j.unfinishedExecutorsAt(tx)).toEqual(["github"]);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(attempts(j.unfinished())).toEqual([
    `${P}/${OPEN}/o-live`,
    `${P}/${STALE}/s-timeout`,
  ]);
});
