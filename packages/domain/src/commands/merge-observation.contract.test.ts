import { expect, test } from "vitest";
import {
  automaticMergeReasons,
  latestMergeCheck,
  recordAutomaticMergeWaits,
  recordMergeCheck,
  recordMergeCheckWait,
  systemConfirmMerge,
  updateCard,
} from "../index.js";
import { system, systemMergeFixture } from "./system-merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

test("C-405: persisted blocker episodes deduplicate, remind once at the configured boundary and never approve", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  const update = (status: "pending" | "passed") =>
    f.commit(
      updateCard(
        f.state,
        human,
        {
          card_id: f.card.id,
          pre_merge_check: { label: "三次远程验证", status },
        },
        f.io,
      ),
    );
  update("pending");
  const scan = (minutes: number) =>
    recordAutomaticMergeWaits(
      f.state,
      system,
      {},
      {
        ...f.io,
        clock: {
          now: () => new Date(Date.UTC(2026, 0, 2, 0, minutes)).toISOString(),
        },
      },
    );
  const first = value(scan(0));
  expect(first.changes).toEqual([]);
  expect(first.events).toMatchObject([
    {
      type: "merge_blocked",
      payload: {
        reasons: ["三次远程验证：待核"],
        pre_merge_checks: ["三次远程验证"],
      },
    },
  ]);
  expect(first.timeline[0]?.body).toContain("三次远程验证");
  f.commit({ ok: true, value: first });
  expect(value(scan(29)).events).toEqual([]);
  const reminder = value(scan(30));
  expect(reminder.events).toMatchObject([{ type: "merge_blocked_reminded" }]);
  expect(reminder.timeline[0]?.body).toContain("PM Office");
  f.commit({ ok: true, value: reminder });
  expect(value(scan(60)).events).toEqual([]);
  expect(
    systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
  update("passed");
  const cleared = value(scan(61));
  expect(cleared.events.map((e) => e.type)).toEqual(["merge_unblocked"]);
  f.commit({ ok: true, value: cleared });
  update("pending");
  f.commit(scan(62));
  expect(value(scan(63)).events).toEqual([]);
  expect(value(scan(92)).events.map((e) => e.type)).toEqual([
    "merge_blocked_reminded",
  ]);
});

test("C-405: changed reasons record once and bind affected work items; only the system may observe", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  const verifier = f.state.work_items.find((w) => w.kind === "verify");
  if (!verifier) throw new Error("Missing verifier");
  const state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === verifier.id ? { ...w, status: "ready" as const } : w,
    ),
  };
  const observed = value(
    recordAutomaticMergeWaits(
      state,
      system,
      { reminder_after_ms: 60_000 },
      f.io,
    ),
  );
  expect(observed.events[0]?.payload).toMatchObject({
    work_item_ids: [verifier.id],
  });
  expect(observed.timeline[0]?.refs).toContainEqual({
    kind: "work_item",
    id: verifier.id,
  });
  expect(observed.changes).toEqual([]);
  const persisted = apply(state, observed);
  expect(
    value(recordAutomaticMergeWaits(persisted, system, {}, f.io)).events,
  ).toEqual([]);
  const changed = {
    ...persisted,
    project_preferences: (persisted.project_preferences ?? []).map((p) => ({
      ...p,
      auto_merge_paused: true,
    })),
  };
  const next = value(recordAutomaticMergeWaits(changed, system, {}, f.io));
  expect(next.events).toHaveLength(1);
  expect(next.events[0]?.payload).toMatchObject({
    reasons: expect.arrayContaining(["自动合并已暂停"]),
  });
  expect(
    value(recordAutomaticMergeWaits(apply(changed, next), system, {}, f.io))
      .events,
  ).toEqual([]);
  for (const actor of [
    human,
    f.actor(f.coder),
    { ...system, project_id: "foreign" },
  ])
    expect(recordAutomaticMergeWaits(state, actor, {}, f.io).ok).toBe(false);
  const reasons = automaticMergeReasons(
    {
      ...state,
      cards: state.cards.map((c) => ({ ...c, sensitive: true })),
      project_preferences: (state.project_preferences ?? []).map((p) => ({
        ...p,
        auto_merge_paused: true,
      })),
    },
    { ...f.card, status: "awaiting_merge", flow_version: 4, sensitive: true },
    q,
  );
  expect(reasons).toEqual(
    expect.arrayContaining([
      "自动合并已暂停",
      "敏感卡片的合并须由人亲自确认。",
      `验证项 ${verifier.id} 未通过`,
    ]),
  );
  expect(
    recordAutomaticMergeWaits(state, system, { reminder_after_ms: -1 }, f.io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-405: review issues and shadow policy failures remain blockers, while passive check waits do not remind PM", async () => {
  const { f, q, check } = await systemMergeFixture();
  f.commit(recordAutomaticMergeWaits(f.state, system, {}, f.io));
  const later = { ...f.io, clock: { now: () => "2026-01-02T01:00:00Z" } };
  expect(
    value(recordAutomaticMergeWaits(f.state, system, {}, later)).events,
  ).toEqual([]);
  check();
  const review = f.state.reviews[0];
  if (!review) throw new Error("Missing review");
  const issues = {
    ...f.state,
    reviews: f.state.reviews.map((r) =>
      r.id === review.id
        ? {
            ...r,
            issues: [
              {
                description: "Fix regression",
                severity: "major" as const,
                must_fix: true,
                pre_existing: false,
              },
            ],
          }
        : r,
    ),
  };
  const blocked = value(recordAutomaticMergeWaits(issues, system, {}, f.io));
  expect(blocked.events[0]?.payload).toMatchObject({
    reasons: expect.arrayContaining([`审核 ${review.id} 有未处理的 must_fix`]),
    work_item_ids: expect.arrayContaining([review.work_item_id]),
  });
  const unconfigured = {
    ...f.state,
    project_preferences: (f.state.project_preferences ?? []).map((p) => ({
      ...p,
      system_merge_shadow_policy: { release_paths: [], role_rule_paths: [] },
    })),
  };
  expect(
    automaticMergeReasons(
      unconfigured,
      { ...f.card, status: "awaiting_merge", flow_version: 4 },
      q,
    ).join("；"),
  ).toContain("授权事件");
  expect(
    value(
      recordAutomaticMergeWaits(
        {
          ...issues,
          project_preferences: (issues.project_preferences ?? []).map((p) => ({
            ...p,
            auto_merge: "off" as const,
          })),
        },
        system,
        {},
        f.io,
      ),
    ).events.every((e) => e.type !== "merge_blocked"),
  ).toBe(true);
});

test("C-405: queue observations keep the original start and never become lifecycle or passing evidence", async () => {
  const { f, completion } = await systemMergeFixture();
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "waiting-check",
    candidate_sha: "c".repeat(40),
    tree_sha: "d".repeat(40),
  };
  f.commit(
    recordMergeCheck(
      { ...f.state, project_settings: { merge_gate_enabled: true } },
      system,
      { ...identity, status: "queued" },
      f.io,
    ),
  );
  const queued = latestMergeCheck(f.state.events, f.card.id, completion.id);
  const wait = (
    reason: string,
    minute: number,
    attempt_id = identity.attempt_id,
  ) =>
    recordMergeCheckWait(
      f.state,
      system,
      { ...identity, attempt_id, reason },
      {
        ...f.io,
        clock: {
          now: () => new Date(Date.UTC(2026, 0, 2, 0, minute)).toISOString(),
        },
      },
    );
  f.commit(wait("等待检查执行容量", 1));
  expect(value(wait("等待检查执行容量", 2)).events).toEqual([]);
  f.commit(wait("等待 GitHub 启动并绑定检查运行", 3));
  expect(
    latestMergeCheck(f.state.events, f.card.id, completion.id),
  ).toMatchObject({
    status: "queued",
    updated_at: queued?.updated_at,
    queue_wait: {
      reason: "等待 GitHub 启动并绑定检查运行",
      queued_at: queued?.updated_at,
    },
  });
  expect(value(wait("old", 4, "stale-attempt")).events).toEqual([]);
  expect(
    recordMergeCheckWait(f.state, human, { ...identity, reason: "fake" }, f.io)
      .ok,
  ).toBe(false);
  f.commit(
    recordMergeCheck(
      { ...f.state, project_settings: { merge_gate_enabled: true } },
      system,
      { ...identity, status: "running" },
      f.io,
    ),
  );
  expect(value(wait("late", 5)).events).toEqual([]);
  expect(
    latestMergeCheck(f.state.events, f.card.id, completion.id)?.queue_wait,
  ).toBeUndefined();
});
