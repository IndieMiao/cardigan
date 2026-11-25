import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  finishRun,
  isReviewStale,
  mergePlan,
  recordDecision,
  recordMergeResult,
  releaseAssignment,
  requestWorktreeCleanup,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, role, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const merged = {
  kind: "merged" as const,
  merge_sha: "b".repeat(40),
  previous_sha: "a".repeat(40),
};

test("invariants 11, 13: only system records a confirmed merge, done is durable and exact replay is a no-op", async () => {
  const f = mergeFixture();
  const { completion } = await f.accept();
  const p = {
    card_id: f.card.id,
    completion_id: completion.id,
    result: merged,
  };
  for (const actor of [
    human,
    f.actor(f.coder),
    f.actor(f.pm),
    { ...system, project_id: "other" },
  ])
    expect(recordMergeResult(f.state, actor, p, f.io)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  expect(recordMergeResult(f.state, system, p, f.io).ok).toBe(false);
  const q = f.state.decisions[0];
  if (!q) throw new Error("Missing confirmation");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "Ready",
        raw_quote: "Merge",
      },
      f.io,
    ),
  );
  const effect = value(recordMergeResult(f.state, system, p, f.io));
  f.commit({ ok: true, value: effect });
  expect(effect.events[0]?.type).toBe("card_merged");
  expect(f.state.cards[0]).toMatchObject({
    status: "done",
    resolution: "done",
  });
  expect(value(recordMergeResult(f.state, system, p, f.io))).toMatchObject({
    changes: [],
    events: [],
    timeline: [],
  });
  expect(
    recordMergeResult(
      f.state,
      system,
      { ...p, result: { ...merged, merge_sha: "c".repeat(40) } },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(["auto", "confirm"] as const)(
  "invariants 13, 14: conflict reopens work and requires fresh completion (%s)",
  async (policy) => {
    const f = mergeFixture(policy);
    const { product, completion } = await f.accept();
    function confirm() {
      if (policy !== "confirm") return;
      const q = f.state.decisions.at(-1);
      if (!q) throw new Error("Missing confirmation");
      expect(mergePlan(f.state, f.card.id).ok).toBe(false);
      f.commit(
        recordDecision(
          f.state,
          human,
          {
            decision_id: q.id,
            option: "merge",
            rationale: "Ready",
            raw_quote: "Merge",
          },
          f.io,
        ),
      );
    }
    confirm();
    const p = {
      card_id: f.card.id,
      completion_id: completion.id,
      result: {
        kind: "conflicted" as const,
        delivery_id: product.id,
        files: ["file.ts"],
      },
    };
    f.commit(recordMergeResult(f.state, system, p, f.io));
    expect(f.state.cards[0]?.status).toBe("in_progress");
    expect(f.state.cards[0]?.resolution).toBeUndefined();
    expect(
      f.state.work_items.find((w) => w.id === product.work_item_id)?.status,
    ).toBe("changes_requested");
    expect(
      f.state.work_items.find((w) => w.id === f.pm.work_item_id)?.status,
    ).toBe("todo");
    expect(value(recordMergeResult(f.state, system, p, f.io)).events).toEqual(
      [],
    );
    const next = await f.deliver("code", "c".repeat(40));
    const old = f.state.reviews.find((r) => r.delivery_id === product.id);
    if (!old) throw new Error("Missing old review");
    expect(isReviewStale(old, next)).toBe(true);
    f.review(next);
    const request = await f.deliver("card_completion", next.subject.value);
    f.review(request);
    expect(f.state.cards[0]?.status).toBe("awaiting_merge");
    confirm();
    expect(
      f.state.decisions.filter((q) => q.trigger === "merge_confirmation"),
    ).toHaveLength(policy === "confirm" ? 2 : 0);
    expect(
      value(mergePlan(f.state, f.card.id)).deliveries[0]?.delivery_id,
    ).toBe(next.id);
    expect(
      recordMergeResult(f.state, system, { ...p, result: merged }, f.io),
    ).toMatchObject({ ok: false, error: { code: "stale_target" } });
    f.commit(
      recordMergeResult(
        f.state,
        system,
        { ...p, completion_id: request.id, result: merged },
        f.io,
      ),
    );
    expect(f.state.cards[0]?.status).toBe("done");
  },
);

test("invariants 11, 13: failure records an event without moving the card; missing targets and malformed results are rejected", async () => {
  const f = mergeFixture("auto");
  const { completion } = await f.accept();
  const p = {
    card_id: f.card.id,
    completion_id: completion.id,
    result: { kind: "failed" as const, reason: "Git unavailable" },
  };
  const effect = value(recordMergeResult(f.state, system, p, f.io));
  f.commit({ ok: true, value: effect });
  expect(effect.changes).toEqual([]);
  expect(effect.events[0]?.type).toBe("merge_failed");
  expect(value(recordMergeResult(f.state, system, p, f.io)).events).toEqual([]);
  for (const result of [
    { ...merged, merge_sha: "short" },
    { kind: "failed" as const, reason: "" },
    {
      kind: "conflicted" as const,
      delivery_id: completion.id,
      files: ["file"],
    },
  ])
    expect(recordMergeResult(f.state, system, { ...p, result }, f.io).ok).toBe(
      false,
    );
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
});

test("invariants 5, 11: release waits for every Run, preserves cleanup metadata and rejects work-item callers", async () => {
  const f = mergeFixture("auto");
  await f.accept(false);
  const p = { assignment_id: f.coder.id };
  expect(releaseAssignment(f.state, f.actor(f.coder), p, f.io).ok).toBe(false);
  expect(releaseAssignment(f.state, system, p, f.io).ok).toBe(false);
  const r = f.state.runs.find(
    (r) => r.assignment_id === f.coder.id && r.status === "running",
  );
  if (!r) throw new Error("Missing run");
  f.commit(
    finishRun(
      f.state,
      f.actor(f.coder),
      { run_id: r.id, outcome: "completed", summary: "Complete" },
      f.io,
    ),
  );
  const released = f.commit(releaseAssignment(f.state, system, p, f.io));
  expect(released).toMatchObject({
    status: "released",
    runtime_state: "released",
    released_at: f.io.clock.now(),
  });
  expect(f.state.events.at(-1)?.payload).toMatchObject({
    assignment_id: f.coder.id,
    token_id: f.coder.mcp_token_id,
  });
  expect(value(releaseAssignment(f.state, system, p, f.io))).toMatchObject({
    changes: [],
    events: [],
  });
});

test("invariant 11: PM Ops can release work items, but only the human can release PM Office", () => {
  const f = mergeFixture();
  // Standing PM assignments are host bootstrap records, not work-item assignments.
  const { work_item_id: _item, ...base } = f.pm;
  const standing = (mode: "office" | "ops"): Assignment => ({
    ...base,
    id: f.io.ids.next(f.state.project_id, "assignment"),
    scope: "standing",
    standing_mode: mode,
    mcp_token_id: `${mode}-token-reference`,
  });
  const office = standing("office");
  const ops = standing("ops");
  const state = {
    ...f.state,
    assignments: [...f.state.assignments, office, ops],
  };
  const opsActor: Actor = {
    ...role("pm"),
    kind: "assignment",
    project_id: state.project_id,
    assignment_id: ops.id,
    allowed_tools: role("pm").allowed_tools.filter(
      (tool) => tool !== "record_decision",
    ),
  };
  const target = { assignment_id: office.id };
  for (const actor of [opsActor, system])
    expect(releaseAssignment(state, actor, target, f.io)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  // A narrow Office token without record_decision must not become Ops.
  expect(
    releaseAssignment(
      state,
      { ...opsActor, assignment_id: office.id },
      { assignment_id: f.coder.id },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  for (const boundary of ["token", "role"]) {
    const withoutRelease = role("pm").allowed_tools.filter(
      (tool) => tool !== "release_assignment" && tool !== "record_decision",
    );
    expect(
      releaseAssignment(
        boundary === "role"
          ? {
              ...state,
              roles: state.roles.map((r) =>
                r.role_id === "pm"
                  ? { ...r, allowed_tools: withoutRelease }
                  : r,
              ),
            }
          : state,
        boundary === "token"
          ? { ...opsActor, allowed_tools: withoutRelease }
          : opsActor,
        { assignment_id: f.coder.id },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  }
  const released = value(releaseAssignment(state, human, target, f.io));
  expect(released.data).toMatchObject({
    id: office.id,
    scope: "standing",
    status: "released",
    runtime_state: "released",
  });
  expect(released.events[0]).toMatchObject({
    type: "assignment_released",
    actor: human,
    payload: { assignment_id: office.id },
  });
  expect(
    value(
      releaseAssignment(state, opsActor, { assignment_id: f.coder.id }, f.io),
    ).data.status,
  ).toBe("released");
});

test.each(["keep", "force_clean"])(
  "invariant 11: released worktree cleanup has one human decision; %s is retained on retries",
  (option) => {
    const f = mergeFixture();
    // A host path observation on a real Assignment; it is not a business status shortcut.
    const state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === f.coder.id
          ? {
              ...a,
              worktree_path: "/fixture/worktree",
              branch: "agent/fixture",
            }
          : a,
      ),
    };
    const p = { assignment_id: f.coder.id, reason: "Uncommitted changes" };
    expect(requestWorktreeCleanup(state, human, p, f.io).ok).toBe(false);
    expect(requestWorktreeCleanup(state, system, p, f.io).ok).toBe(false);
    expect(releaseAssignment(state, system, p, f.io).ok).toBe(false);
    f.commit(releaseAssignment(state, human, p, f.io));
    const q = f.commit(requestWorktreeCleanup(f.state, system, p, f.io));
    expect(q).toMatchObject({
      trigger: "worktree_cleanup",
      assignment_id: f.coder.id,
      category: "data_deletion",
      decider: "human",
      blocking: false,
    });
    expect(q.question).toBe(`保留还是强制清理 ${f.coder.id} 的工作区？`);
    for (const option of q.options) {
      expect(option.description).toMatch(/^[\u4e00-\u9fff]+$/u);
      expect(option.impact).toMatch(/^[\u4e00-\u9fff，]+$/u);
    }
    expect(
      value(requestWorktreeCleanup(f.state, system, p, f.io)),
    ).toMatchObject({ data: q, changes: [], events: [] });
    f.commit(
      recordDecision(
        f.state,
        human,
        { decision_id: q.id, option, rationale: "Reviewed", raw_quote: option },
        f.io,
      ),
    );
    expect(
      value(requestWorktreeCleanup(f.state, system, p, f.io)),
    ).toMatchObject({
      data: { status: "resolved", resolution: { option } },
      changes: [],
      events: [],
    });
  },
);

test("C-664: a released work-item record that lost its path records the host-observed worktree with its one decision", () => {
  const f = mergeFixture();
  const coder = f.state.assignments.find((a) => a.id === f.coder.id);
  expect(coder?.scope).toBe("work_item");
  expect(coder?.worktree_path).toBeUndefined();
  const path = `/worker/worktrees/${f.state.project_id}/${f.coder.id}`;
  const p = {
    assignment_id: f.coder.id,
    reason: "Uncommitted changes",
    worktree_path: path,
  };
  // Still only after release, and still only by the system.
  expect(requestWorktreeCleanup(f.state, system, p, f.io).ok).toBe(false);
  f.commit(releaseAssignment(f.state, human, p, f.io));
  expect(requestWorktreeCleanup(f.state, human, p, f.io).ok).toBe(false);
  // Without an observation there is still nothing to decide.
  expect(
    requestWorktreeCleanup(
      f.state,
      system,
      { assignment_id: f.coder.id, reason: "none" },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  // Only the Assignment's own absolute directory is accepted.
  for (const worktree_path of [
    "relative/A-1",
    `/worker/worktrees/${f.state.project_id}/A-999999`,
    `/worker/../${f.coder.id}`,
  ])
    expect(
      requestWorktreeCleanup(f.state, system, { ...p, worktree_path }, f.io),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  const q = f.commit(requestWorktreeCleanup(f.state, system, p, f.io));
  expect(q).toMatchObject({
    trigger: "worktree_cleanup",
    assignment_id: f.coder.id,
    category: "data_deletion",
    decider: "human",
  });
  expect(
    f.state.assignments.find((a) => a.id === f.coder.id)?.worktree_path,
  ).toBe(path);
  // Replays are no-ops; a different path for the now-recorded one is refused.
  expect(value(requestWorktreeCleanup(f.state, system, p, f.io))).toMatchObject(
    { data: q, changes: [], events: [] },
  );
  expect(
    requestWorktreeCleanup(
      f.state,
      system,
      { ...p, worktree_path: `/elsewhere/${f.coder.id}` },
      f.io,
    ).ok,
  ).toBe(false);
});
