import { expect, test } from "vitest";
import type { Card } from "../entities.js";
import {
  effectiveStartPoint,
  normalizeStartPoint,
  UNREGISTERED_WORKTREE_REASON,
  worktreeUnavailableReason,
} from "../start-point.js";
import { updateCard, updateWorkItem } from "./pm.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const sha = "9172f56f".padEnd(40, "0");
const c1 = id("card", 1),
  w1 = id("work_item", 1),
  w2 = id("work_item", 2);
const registry = [{ repo: "/srv/source/sensen", base_branch: "main" }];
const io = () => ({ ...ports(), project_repositories: registry });

/** C-99 shape: a no-merge card without a registered repository, no worktree yet. */
function noMerge(overrides: Partial<Card> = {}) {
  const s = fixture();
  const { repo: _r, base_branch: _b, ...bare } = s.cards[0] as Card;
  return {
    ...s,
    cards: [{ ...bare, merge_policy: "none" as const, ...overrides }],
  };
}
const card = (s: ReturnType<typeof fixture>) =>
  s.cards.find((c) => c.id === c1) as Card;

test("normalizeStartPoint accepts full SHAs and plain branches only", () => {
  expect(normalizeStartPoint(sha.toUpperCase())).toBe(sha);
  expect(normalizeStartPoint("b".repeat(64))).toBe("b".repeat(64));
  expect(normalizeStartPoint("release/0.4")).toBe("release/0.4");
  for (const bad of [
    "9172f56f",
    "HEAD~1",
    "refs/heads/main",
    "-x",
    "a..b",
    "",
    "main^",
    "x y",
    7,
  ])
    expect(normalizeStartPoint(bad)).toBeUndefined();
});

test("PM registers the repository and start point of a no-merge card", () => {
  const s = noMerge();
  const pm = actor(4, "pm");
  const effect = value(
    updateCard(s, pm, { card_id: c1, start_point: sha.toUpperCase() }, io()),
  );
  expect(effect.data).toMatchObject({
    repo: registry[0]?.repo,
    base_branch: "main",
    start_point: sha,
  });
  const event = effect.events.find((e) => e.type === "card_updated");
  expect(event?.payload).toMatchObject({
    repository: {
      repo: registry[0]?.repo,
      base_branch: "main",
      start_point: sha,
    },
    previous_repository: { repo: null, base_branch: null, start_point: null },
  });
  expect(effect.timeline.at(-1)?.body).toContain(`起点：${sha}`);
  // An explicit repository and branch are kept as given; null clears the start.
  const next = apply(s, effect);
  const cleared = value(
    updateCard(
      next,
      human,
      {
        card_id: c1,
        repo: "other/repo",
        base_branch: "release",
        start_point: null,
      },
      io(),
    ),
  ).data;
  expect(cleared).toMatchObject({ repo: "other/repo", base_branch: "release" });
  expect(cleared).not.toHaveProperty("start_point");
});

test("start points are refused on merge cards and for malformed values", () => {
  const merge = fixture();
  expect(
    updateCard(merge, human, { card_id: c1, start_point: sha }, io()),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("merge_policy=none") },
  });
  expect(card(merge)).not.toHaveProperty("start_point");
  expect(
    updateCard(noMerge(), human, { card_id: c1, start_point: "abc1234" }, io()),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  // Without any registered repository the start point has nothing to resolve in.
  expect(
    updateCard(
      noMerge(),
      human,
      { card_id: c1, start_point: sha },
      { ...ports(), project_repositories: [] },
    ),
  ).toMatchObject({ ok: false, error: { message: "起点需要仓库（repo）" } });
  // Only PM or the human registers.
  expect(
    updateCard(noMerge(), actor(1), { card_id: c1, start_point: sha }, io()),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
});

test("a placed worktree freezes the repository and start point", () => {
  const s = noMerge({ repo: "r", base_branch: "main", start_point: sha });
  const placed = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, worktree_path: "/w/A-1", base_sha: sha }
        : a,
    ),
  };
  for (const p of [
    { start_point: "release" },
    { start_point: null },
    { repo: "other" },
    { base_branch: "dev" },
  ])
    expect(
      updateCard(placed, human, { card_id: c1, ...p }, io()),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(
    updateWorkItem(placed, human, { work_item_id: w1, start_point: "x" }, io()),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  // Same values and unrelated edits still pass.
  expect(
    updateCard(
      placed,
      human,
      { card_id: c1, start_point: sha, title: "T" },
      io(),
    ).ok,
  ).toBe(true);
});

test("a producer's own start point overrides the card's", () => {
  const s = noMerge({ repo: "r", base_branch: "main", start_point: "main" });
  const effect = value(
    updateWorkItem(s, human, { work_item_id: w1, start_point: sha }, io()),
  );
  const item = effect.data;
  expect(item.start_point).toBe(sha);
  expect(effectiveStartPoint(card(s), item)).toBe(sha);
  expect(effect.events.at(-1)?.payload).toMatchObject({
    start_point: sha,
    previous_start_point: null,
  });
  const cleared = value(
    updateWorkItem(
      apply(s, effect),
      human,
      { work_item_id: w1, start_point: null },
      io(),
    ),
  ).data;
  expect(cleared).not.toHaveProperty("start_point");
  expect(effectiveStartPoint(card(s), cleared)).toBe("main");
  // Verifiers never have a start point.
  expect(
    updateWorkItem(s, human, { work_item_id: w2, start_point: sha }, io()),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("merge cards never use a start point, even a stored one", () => {
  const item = { kind: "produce" as const, start_point: sha };
  for (const merge_policy of ["confirm", "auto", undefined] as const)
    expect(
      effectiveStartPoint(
        merge_policy === undefined
          ? { start_point: sha }
          : { merge_policy, start_point: sha },
        item,
      ),
    ).toBeUndefined();
  expect(
    effectiveStartPoint({ merge_policy: "none" }, { kind: "verify" }),
  ).toBeUndefined();
});

test("an unregistered card explains why a source role has no worktree", () => {
  const wa = { scope: "work_item" as const };
  expect(worktreeUnavailableReason({ worktree: "write" }, wa, {})).toBe(
    UNREGISTERED_WORKTREE_REASON,
  );
  expect(worktreeUnavailableReason({ worktree: "readonly" }, wa, {})).toBe(
    "本卡未登记仓库/起点",
  );
  for (const [role, assignment, c] of [
    [{ worktree: "none" }, wa, {}],
    [{ worktree: "write" }, { scope: "standing" }, {}],
    [{ worktree: "write" }, { ...wa, worktree_path: "/w" }, {}],
    [{ worktree: "write" }, wa, { repo: "r" }],
    [{}, wa, {}],
  ] as const)
    expect(worktreeUnavailableReason(role, assignment, c)).toBeUndefined();
});

test("a delivered card keeps its repository and baseline branch", () => {
  const s = fixture();
  const delivered = {
    ...s,
    deliveries: [{ id: id("delivery", 1), work_item_id: w1 }],
  } as unknown as ReturnType<typeof fixture>;
  for (const p of [{ repo: "other" }, { base_branch: "dev" }])
    expect(
      updateCard(delivered, human, { card_id: c1, ...p }, io()),
    ).toMatchObject({
      ok: false,
      error: { message: "本卡已有交付，不能再改仓库或基线分支" },
    });
  expect(
    updateCard(s, human, { card_id: c1, base_branch: "dev" }, io()).ok,
  ).toBe(true);
});
