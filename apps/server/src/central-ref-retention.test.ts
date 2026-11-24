import { updateCard } from "@cardigan/domain";
import { afterEach, expect, test } from "vitest";
import {
  expiredRefs,
  type RefOwners,
  refCard,
  storeRefOwners,
} from "./central-ref-retention.js";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";

const a = "a".repeat(40),
  b = "b".repeat(40),
  long = "c".repeat(64);
const owners: RefOwners = {
  expiredCards: new Set(["C-1"]),
  assignmentCard: new Map([
    ["A-1", "C-1"],
    ["A-2", "C-2"],
  ]),
  deliveryCard: new Map([
    ["D-1", "C-1"],
    ["D-2", "C-2"],
  ]),
  precheckCard: new Map([
    ["06H0ATTEMPT1", "C-1"],
    ["06H0ATTEMPT2", "C-2"],
  ]),
};

test("Q-1233: every candidate and precheck ref form resolves to its card", () => {
  for (const [ref, card] of [
    [`refs/cardigan/prechecks/A-1/${a}`, "C-1"],
    [`refs/cardigan/candidates/A-2/${long}`, "C-2"],
    ["refs/cardigan/candidates/recovery/A-1", "C-1"],
    ["refs/cardigan/candidates/start/A-2", "C-2"],
    ["refs/cardigan/candidates/precheck-06H0ATTEMPT2", "C-2"],
    [`refs/cardigan/candidates/macos-D-1-${b}`, "C-1"],
    ["refs/cardigan/candidates/D-2", "C-2"],
  ] as const)
    expect(refCard(ref, owners), ref).toBe(card);
  for (const ref of [
    "refs/cardigan/candidates/MB-4",
    "refs/cardigan/candidates/A-9/" + a,
    "refs/cardigan/candidates/precheck-unknown",
    "refs/cardigan/candidates/something/else",
    `refs/cardigan/prechecks/A-1/${a.slice(1)}`,
  ])
    expect(refCard(ref, owners), ref).toBeUndefined();
});

test("Q-1233: only refs of expired cards in the two namespaces expire", () => {
  const refs = [
    `refs/cardigan/prechecks/A-1/${a}`,
    `refs/cardigan/candidates/A-2/${a}`,
    "refs/cardigan/candidates/D-1",
    "refs/cardigan/candidates/precheck-06H0ATTEMPT2",
    "refs/cardigan/candidates/MB-4",
    "refs/cardigan/deliveries/D-1",
    "refs/cardigan/backups/x/agent/A-1",
  ].map((ref) => ({ ref, sha: a }));
  expect(expiredRefs(refs, owners).map((r) => r.ref)).toEqual([
    `refs/cardigan/prechecks/A-1/${a}`,
    "refs/cardigan/candidates/D-1",
  ]);
});

let f: M4Fixture | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});

test("Q-1233: a card counts as expired only after it ended and stayed quiet past the cutoff", async () => {
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  f = m4Fixture({
    project_id: "retention",
    clock: { now: () => new Date(now).toISOString() as never },
  });
  const fixture = f;
  const scenario = m4Scenario(fixture);
  fixture.startRun(scenario.coder);
  const delivery = await fixture.deliver(
    scenario.coder,
    scenario.development.id,
    { subject: a, verifiers: [scenario.codeReview.id] },
  );
  const read = (cutoff: string) =>
    storeRefOwners(fixture.store, fixture.project_id, cutoff);
  const open = read("2031-01-01T00:00:00.000Z");
  expect(open.expiredCards.size).toBe(0);
  expect(open.assignmentCard.get(scenario.coder.id)).toBe(scenario.card.id);
  expect(open.deliveryCard.get(delivery.id)).toBe(scenario.card.id);

  now = Date.parse("2030-01-02T00:00:00.000Z");
  fixture.apply((s, actor, p) =>
    updateCard(s, actor, { card_id: scenario.card.id, status: "cancelled" }, p),
  );
  // Raw row: only the attempt-to-card query reads it.
  fixture.store.database
    .prepare(
      "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      fixture.project_id,
      "EV-PRECHECK",
      scenario.card.id,
      "test-precheck",
      1,
      "precheck_queued",
      JSON.stringify({
        type: "precheck_queued",
        created_at: "2029-12-31T00:00:00.000Z",
        payload: { attempt_id: "06H0ATTEMPT1", card_id: scenario.card.id },
      }),
    );
  expect(
    read("2031-01-01T00:00:00.000Z").precheckCard.get("06H0ATTEMPT1"),
  ).toBe(scenario.card.id);
  // Ended on 2030-01-02: not expired at a cutoff before that, expired after.
  expect(read("2030-01-01T12:00:00.000Z").expiredCards.size).toBe(0);
  expect([...read("2030-01-02T00:00:01.000Z").expiredCards]).toEqual([
    scenario.card.id,
  ]);
});
