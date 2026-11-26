import { beforeEach, expect, test } from "vitest";
import type { Actor, Delivery } from "../entities.js";
import {
  type CommandState,
  EARLY_MERGE_CONFLICT,
  earlyConflictTargets,
  notifyEarlyMergeConflicts,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: "fixture-project" };
const head = "a".repeat(40);
const baseline = "b".repeat(40);
let io = ports();
beforeEach(() => {
  io = ports();
});

const delivery = (n: number, sha = head): Delivery => ({
  id: id("delivery", n),
  work_item_id: id("work_item", 1),
  run_id: id("run", 1),
  kind: "code",
  subject: { kind: "git_head", value: sha },
  summary: "Ready",
  status: "submitted",
  requested_verifiers: [id("work_item", 2)],
  attachments: [],
  evidence: [],
  known_gaps: [],
});

/** C-1 in review with W-1's D-1 delivered; the author's only Run has finished. */
function delivered(): CommandState {
  const s = fixture();
  return {
    ...s,
    cards: s.cards.map((c) =>
      c.id === id("card", 1) ? { ...c, status: "review" } : c,
    ),
    work_items: s.work_items.map((w) =>
      w.id === id("work_item", 1) && w.kind === "produce"
        ? { ...w, status: "delivered" as const }
        : w,
    ),
    deliveries: [delivery(1)],
    runs: [{ ...run(1), status: "completed" }, run(2), run(3)],
  };
}
const probe = (
  files = ["b.ts", "a.ts", "b.ts"],
  delivery_id = 1,
  sha = head,
) => ({
  card_id: id("card", 1),
  work_item_id: id("work_item", 1),
  delivery_id: id("delivery", delivery_id),
  head_sha: sha,
  files,
});
const notify = (
  s: CommandState,
  probes = [probe()],
  baseline_sha = baseline,
  caller: Actor = system,
) =>
  notifyEarlyMergeConflicts(
    s,
    caller,
    { base_branch: "main", baseline_sha, probes },
    io,
  );
const early = (s: CommandState) =>
  s.events.filter((e) => e.type === EARLY_MERGE_CONFLICT);

test("C-782: a conflict on a delivered head tells the idle author once, without changing card, work or review state", () => {
  const s = delivered();
  const effect = value(notify(s));
  expect(effect.data).toEqual([id("delivery", 1)]);
  expect(effect.changes).toEqual([]);
  expect(effect.events).toHaveLength(1);
  expect(effect.events[0]).toMatchObject({
    type: EARLY_MERGE_CONFLICT,
    card_id: id("card", 1),
    actor: system,
    payload: {
      work_item_id: id("work_item", 1),
      assignment_id: id("assignment", 1),
      delivery_id: id("delivery", 1),
      head_sha: head,
      base_branch: "main",
      baseline_sha: baseline,
      files: ["a.ts", "b.ts"],
    },
  });
  expect(effect.timeline[0]?.body).toContain("a.ts、b.ts");
  expect(effect.timeline[0]?.body).toContain("本交付不再重复提醒");
});

test("C-782: later baseline moves for the same delivery fold into the first notice", () => {
  let s = apply(delivered(), value(notify(delivered())));
  expect(earlyConflictTargets(s, "main")).toEqual([]);
  for (const sha of [baseline, "c".repeat(40)]) {
    const effect = value(notify(s, [probe(["c.ts"])], sha));
    expect(effect.events).toEqual([]);
    s = apply(s, effect);
  }
  expect(early(s)).toHaveLength(1);
  // A duplicate probe in one sweep is one notice as well.
  expect(
    value(notify(delivered(), [probe(), probe(["c.ts"])])).events,
  ).toHaveLength(1);
});

test.each(["queued", "running"] as const)(
  "C-782: an author with a %s Run is told only after it ends",
  (status) => {
    const busy = {
      ...delivered(),
      runs: [{ ...run(1), status }, run(2), run(3)],
    };
    const deferred = value(notify(busy));
    expect(deferred.events).toEqual([]);
    expect(earlyConflictTargets(busy, "main")).toHaveLength(1);
    expect(value(notify(delivered())).events).toHaveLength(1);
  },
);

test("C-782: a new delivery gets its own single notice", () => {
  const first = apply(delivered(), value(notify(delivered())));
  const redelivered = {
    ...first,
    deliveries: [
      { ...delivery(1), status: "superseded" as const },
      delivery(2, "d".repeat(40)),
    ],
  };
  expect(earlyConflictTargets(redelivered, "main")).toEqual([
    {
      card_id: id("card", 1),
      work_item_id: id("work_item", 1),
      delivery_id: id("delivery", 2),
      head_sha: "d".repeat(40),
    },
  ]);
  // Evidence probed for the superseded head is stale.
  expect(value(notify(redelivered)).events).toEqual([]);
  expect(
    value(notify(redelivered, [probe(["a.ts"], 2, "d".repeat(40))])).events,
  ).toHaveLength(1);
});

test.each([
  [
    "card in progress",
    (s: CommandState) => ({
      ...s,
      cards: s.cards.map((c) => ({ ...c, status: "in_progress" as const })),
    }),
  ],
  [
    "card on hold",
    (s: CommandState) => ({
      ...s,
      cards: s.cards.map((c) => ({
        ...c,
        hold: {
          reason: "Paused",
          resume_condition: "Owner resumes",
          set_by: "human" as const,
          set_at: "2026-01-01T00:00:00.000Z",
        },
      })),
    }),
  ],
  [
    "other base branch",
    (s: CommandState) => ({
      ...s,
      cards: s.cards.map((c) => ({ ...c, base_branch: "release" })),
    }),
  ],
  [
    "inactive author",
    (s: CommandState) => ({
      ...s,
      assignments: s.assignments.map((a) =>
        a.id === id("assignment", 1)
          ? { ...a, status: "released" as const }
          : a,
      ),
    }),
  ],
  [
    "head mismatch",
    (s: CommandState) => ({
      ...s,
      deliveries: [delivery(1, "e".repeat(40))],
    }),
  ],
])("C-782: no notice for %s", (_case, change) => {
  expect(value(notify(change(delivered()))).events).toEqual([]);
});

test("C-782: only the system can record trial-merge conflicts, with a full baseline and listed files", () => {
  const s = delivered();
  expect(notify(s, [probe()], baseline, actor()).ok).toBe(false);
  expect(notify(s, [probe()], "main").ok).toBe(false);
  expect(notify(s, [probe([])]).ok).toBe(false);
});
