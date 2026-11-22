import { expect, test } from "vitest";
import {
  type CommandState,
  deriveCardFields,
  postComment,
  type ReviewPauseInput,
  remindDecisionFollowups,
  reviewWakeBlocked,
  type TimelineEntryId,
  updateWorkItem,
} from "../index.js";
import { first, sharedReviewFixture } from "./shared-review/test-fixtures.js";
import { actor, apply, id, value } from "./test-fixtures.js";

const pm = actor(4, "pm");
const owner = id("assignment", 1);
const reviewers = [id("assignment", 2), id("assignment", 3)];
const plan = { owner, confirmers: reviewers, next_step: "提交状态与证据表" };
async function fixture(start: string) {
  const f = await sharedReviewFixture();
  f.review(2, [first]);
  f.review(3, [], f.refs());
  let state = f.state;
  const q = state.decisions[0];
  if (!q?.card_id) throw Error("Missing shared decision");
  const card = state.cards.find((c) => c.id === q.card_id);
  if (!card) throw Error("Missing card");
  let at = start;
  const io = {
    ...f.io,
    clock: { now: () => new Date(`2026-11-22T${at}+08:00`).toISOString() },
  };
  const resolution = (
    option: "pause" | "raise_limit",
    pause_plan?: ReviewPauseInput,
  ) =>
    updateWorkItem(
      state,
      pm,
      {
        work_item_id: id("work_item", 2),
        review_limit_decision: {
          decision_id: q.id,
          option,
          rationale: "先核对两路证据，再返工",
          ...(pause_plan ? { pause_plan } : {}),
        },
      },
      io,
    );
  const comment = (
    n: number,
    step: "propose" | "confirm",
    reply_to?: TimelineEntryId,
  ) =>
    postComment(
      state,
      actor(
        n,
        n === 1 ? "coder" : n === 2 ? "reviewer" : "independent_reviewer",
      ),
      {
        card_id: card.id,
        body: step === "propose" ? "状态与证据表" : "已核对证据表",
        review_plan: { decision_id: q.id, step },
        ...(reply_to ? { reply_to } : {}),
      },
      io,
    );
  return {
    q,
    get state() {
      return state;
    },
    change: (s: CommandState) => {
      state = s;
    },
    time: (t: string) => {
      at = t;
    },
    resolution,
    resolve: (option: "pause" | "raise_limit", p?: ReviewPauseInput) => {
      state = apply(state, value(resolution(option, p)));
    },
    view: () => deriveCardFields({ ...state, card }),
    comment,
    post: (n: number, step: "propose" | "confirm", reply?: TimelineEntryId) => {
      const effect = value(comment(n, step, reply));
      state = apply(state, effect);
      if (!effect.data) throw Error("Missing entry");
      return effect.data.id;
    },
    tick: () => {
      const effect = value(
        remindDecisionFollowups(
          state,
          { kind: "system", project_id: state.project_id },
          io,
        ),
      );
      state = apply(state, effect);
      return effect.events.map((e) => e.payload);
    },
  };
}

test("PM pause rejects missing, duplicate, foreign or inactive participants and invalid deadlines before emitting an instruction", async () => {
  const f = await fixture("08:10:24");
  for (const p of [
    undefined,
    { ...plan, next_step: " " },
    { ...plan, confirmers: [] },
    { ...plan, confirmers: [owner] },
    { ...plan, confirmers: [...reviewers, ...reviewers] },
    { ...plan, owner: id("assignment", 4) },
    { ...plan, review_at: "2026-11-22T09:30:00" },
    { ...plan, review_at: "2026-11-22T08:10:24+08:00" },
  ])
    expect(f.resolution("pause", p)).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  f.change({
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === owner ? { ...a, status: "suspended" } : a,
    ),
  });
  expect(f.resolution("pause", plan).ok).toBe(false);
  f.change({
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === owner ? { ...a, status: "active" } : a,
    ),
    work_items: f.state.work_items.map((w) =>
      w.assignment_id === owner ? { ...w, card_id: id("card", 2) } : w,
    ),
  });
  expect(f.resolution("pause", plan).ok).toBe(false);
});

test("C-549/Q-1107 replay: 08:10 pause, no progress until the evidence table; escalate once per audience and require both reviewers on the current version", async () => {
  const f = await fixture("08:10:24");
  f.resolve("pause", plan);
  expect(f.state.decisions[0]?.review_pause?.review_at).toBe(
    "2026-11-22T00:40:24.000Z",
  );
  expect(f.view()).toMatchObject({
    why: `待方案 ${f.q.id}`,
    next_owners: [{ kind: "assignment", ref: owner }],
  });
  const instructions = () =>
    f.state.events.filter((e) => e.type === "instruction_issued");
  expect(instructions().map((e) => e.payload)).toEqual([
    {
      work_item_id: id("work_item", 1),
      decision_id: f.q.id,
      pause_recipient: owner,
    },
  ]);
  f.time("08:40:23");
  expect(f.tick()).toEqual([]);
  f.time("08:40:24");
  expect(f.tick()).toMatchObject([{ audience: "pm_ops", decision_id: f.q.id }]);
  f.change(structuredClone(f.state));
  expect(f.tick()).toEqual([]);
  f.time("09:10:23");
  expect(f.tick()).toEqual([]);
  f.time("09:10:24");
  expect(f.tick()).toMatchObject([
    { audience: "pm_office", decision_id: f.q.id },
  ]);
  f.time("12:12:00");
  expect(f.tick()).toEqual([]);
  f.time("12:16:00");
  expect(f.comment(2, "propose").ok).toBe(false);
  const first = f.post(1, "propose");
  expect(
    instructions()
      .slice(-2)
      .map((e) => e.payload),
  ).toMatchObject(
    reviewers.map((pause_recipient) => ({
      pause_recipient,
      proposal: first,
      decision_id: f.q.id,
    })),
  );
  const old = instructions().at(-1);
  expect(reviewWakeBlocked(f.state, old, id("work_item", 3))).toBe(false);
  f.post(2, "confirm", first);
  expect(f.resolution("raise_limit").ok).toBe(false);
  const revised = f.post(1, "propose");
  expect(reviewWakeBlocked(f.state, old, id("work_item", 3))).toBe(true);
  expect(f.comment(3, "confirm", first).ok).toBe(false);
  expect(f.comment(1, "confirm", revised).ok).toBe(false);
  f.post(2, "confirm", revised);
  expect(f.comment(2, "confirm", revised).ok).toBe(false);
  expect(f.view()).toMatchObject({
    why: `待确认 ${f.q.id}`,
    next_owners: [{ kind: "assignment", ref: reviewers[1] }],
  });
  f.post(3, "confirm", revised);
  expect(f.view().why).toContain("待 PM 结案恢复");
  expect(
    f.state.events.filter((e) => e.type === "review_pause_notice"),
  ).toHaveLength(3);
  expect(f.state.decisions[0]?.status).toBe("provisional");
  expect(
    f.state.work_items.filter((w) => w.kind === "verify").map((w) => w.status),
  ).toEqual(["waiting_decision", "waiting_decision"]);
});

test("C-555/Q-1108 replay: two confirmations, 09:49 explicit release; permission to rework is not evidence of dispatch or the 10:16 re-review", async () => {
  const f = await fixture("07:22:00");
  f.resolve("pause", { ...plan, review_at: "2026-11-22T08:00:00+08:00" });
  f.time("08:00:00");
  expect(f.tick()).toMatchObject([{ audience: "pm_ops" }]);
  f.time("08:38:00");
  expect(f.tick()).toMatchObject([{ audience: "pm_office" }]);
  const p = f.post(1, "propose");
  f.post(3, "confirm", p);
  f.post(2, "confirm", p);
  expect(f.state.events.at(-1)).toMatchObject({
    type: "review_pause_notice",
    payload: { audience: "pm_ops", decision_id: f.q.id },
  });
  f.time("09:49:38");
  f.resolve("raise_limit");
  expect(f.view().why).toContain("已允许返工但未派发");
  expect(
    f.state.work_items.filter((w) => w.kind === "verify").map((w) => w.status),
  ).toEqual(["ready", "ready"]);
  const release = f.state.events.findLast(
    (e) => e.type === "decision_resolved",
  );
  const r = f.state.runs.find((r) => r.assignment_id === owner);
  if (!r || !release) throw Error("Missing repair target");
  const dispatched = {
    ...r,
    id: id("run", 700),
    trigger_event_id: release.id,
    kind: "rework" as const,
    status: "dispatched" as const,
  };
  f.change({ ...f.state, runs: [...f.state.runs, dispatched] });
  expect(f.view().why).not.toContain("未派发");
  f.time("10:16:19");
  expect(f.tick()).toEqual([]);
});
