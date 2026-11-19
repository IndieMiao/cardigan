import { expect, test } from "vitest";
import {
  type CommandState,
  type ReviewIssue,
  sharedMustFixes,
  submitReview,
  updateWorkItem,
} from "../index.js";
import {
  parallelBug,
  parallelDelivery,
  parallelState,
} from "./parallel-review/test-fixtures.js";
import { actor, apply, id, ports, role, value } from "./test-fixtures.js";

const first = parallelBug;
const second = {
  ...first,
  description: "A second missing check",
  proof: "Reproduced with another fixture",
};
async function fixture(prior = 3) {
  const base = parallelState();
  const io = ports();
  let state: CommandState = {
    ...base,
    roles: [...base.roles, role("independent_reviewer")],
    assignments: base.assignments.map((a) =>
      a.scope === "standing"
        ? { ...a, standing_mode: "ops" }
        : a.id === id("assignment", 3)
          ? { ...a, role_id: "independent_reviewer" }
          : a,
    ),
    work_items: base.work_items.map((w) =>
      w.kind === "verify"
        ? {
            ...w,
            max_review_rounds: 4,
            role_id:
              w.id === id("work_item", 3) ? "independent_reviewer" : "reviewer",
          }
        : w,
    ),
  };
  const delivery = await parallelDelivery(state, io);
  const target = delivery.data;
  state = apply(state, delivery);
  state = {
    ...state,
    reviews: [2, 3].flatMap((n) =>
      Array.from({ length: prior }, (_, k) => ({
        id: id("review", n * 10 + k),
        work_item_id: id("work_item", n),
        delivery_id: id("delivery", k + 1),
        target_sha: "b".repeat(40),
        run_id: id("run", n * 10 + k),
        kind: "code" as const,
        issues: [first, second],
        verdict: "reject" as const,
        blocking: true,
        recheck_required: false,
        attachments: [],
      })),
    ),
  };
  const who = (n: number) =>
    actor(n, n === 2 ? "reviewer" : "independent_reviewer");
  const submit = (
    n: number,
    issues: ReviewIssue[],
    refs: string[] = [],
    snapshot = state,
    sha = target.subject.value,
  ) =>
    submitReview(
      snapshot,
      who(n),
      {
        delivery_id: target.id,
        target_sha: sha,
        kind: "code",
        issues,
        issue_refs: refs,
      },
      io,
    );
  function review(n: number, issues: ReviewIssue[], refs: string[] = []) {
    const result = value(submit(n, issues, refs));
    state = apply(state, result);
    return result.data;
  }
  function decide(n: number, option: "raise_limit" | "pause" | "escalate") {
    const q = state.decisions[0];
    if (!q) throw Error("Missing decision");
    const result = updateWorkItem(
      state,
      actor(4, "pm"),
      {
        work_item_id: id("work_item", n),
        review_limit_decision: {
          decision_id: q.id,
          option,
          rationale: "已核对本次交付",
        },
      },
      io,
    );
    if (result.ok) state = apply(state, result.value);
    return result;
  }
  return {
    submit,
    review,
    decide,
    target,
    io,
    get state() {
      return state;
    },
    refs: () => sharedMustFixes(state.reviews).map((i) => i.finding_id),
  };
}

test.each([2, 3])(
  "either lane can publish first (%i); matching sets join one pause, then one raise",
  async (n) => {
    const f = await fixture();
    const other = 5 - n;
    const a = f.review(n, [first, second]);
    expect(f.refs()).toHaveLength(2);
    if (n === 2) expect(f.decide(n, "pause").ok).toBe(true);
    const b = f.review(other, [], f.refs().reverse());
    if (n === 3) expect(f.decide(other, "pause").ok).toBe(true);
    expect([a.verdict, b.verdict]).toEqual(["reject", "reject"]);
    expect(f.refs()).toHaveLength(2);
    expect(
      f.state.events.filter((e) => e.type === "decision_requested"),
    ).toHaveLength(1);
    expect(f.state.decisions).toMatchObject([
      {
        status: "provisional",
        affected_work_items: [a.work_item_id, b.work_item_id],
      },
    ]);
    expect(
      f.state.work_items
        .filter((w) => w.kind === "verify")
        .map((w) => w.status),
    ).toEqual(["waiting_decision", "waiting_decision"]);
    expect(f.decide(other, "raise_limit").ok).toBe(true);
    expect(f.decide(n, "raise_limit").ok).toBe(false);
    expect(
      f.state.work_items
        .filter((w) => w.kind === "verify")
        .map((w) => [w.status, w.kind === "verify" && w.max_review_rounds]),
    ).toEqual([
      ["ready", 5],
      ["ready", 5],
    ]);
    expect(
      f.state.events
        .filter((e) => e.type === "review_limit_rejections_acknowledged")
        .map((e) => e.payload),
    ).toEqual(
      [a, b].map((r) => ({
        decision_id: f.state.decisions[0]?.id,
        work_item_id: r.work_item_id,
        review_id: r.id,
      })),
    );
  },
);

test("a resolved raise covers a later exact match, but does not grant a round before its own fourth rejection", async () => {
  const f = await fixture();
  f.review(3, [first]);
  expect(f.decide(3, "raise_limit").ok).toBe(true);
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 2)),
  ).toMatchObject({ max_review_rounds: 4 });
  f.review(2, [first]);
  expect(f.state.decisions).toHaveLength(1);
  expect(f.refs()).toHaveLength(1);
  expect(f.state.decisions[0]).toMatchObject({
    status: "resolved",
    affected_work_items: [id("work_item", 3), id("work_item", 2)],
  });
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 2)),
  ).toMatchObject({ max_review_rounds: 5, status: "ready" });
  expect(
    f.state.runs
      .find((r) => r.id === id("run", 2))
      ?.review_limit_changes?.at(-1)?.actor,
  ).toEqual(f.state.decisions[0]?.resolution?.resolved_by);
  expect(f.submit(2, [], f.refs()).ok).toBe(false);
  expect(
    f.state.events.filter((e) => e.type === "decision_resolved"),
  ).toHaveLength(1);
});

test("a subset is a distinct decision; escalation of a shared set cannot be reversed by the late verifier", async () => {
  const f = await fixture();
  f.review(2, [first, second]);
  f.review(3, [], f.refs().slice(0, 1));
  expect(f.state.decisions).toHaveLength(2);
  const g = await fixture();
  g.review(2, [first]);
  expect(g.decide(2, "escalate").ok).toBe(true);
  g.review(3, [], g.refs());
  expect(g.state.decisions).toMatchObject([
    { status: "open", decider: "human" },
  ]);
  expect(g.decide(3, "raise_limit").ok).toBe(false);
});

test("references neither supply a verdict nor bypass author, delivery, SHA or new-finding checks", async () => {
  const f = await fixture(0);
  const firstReview = f.review(2, [first]);
  const refs = f.refs();
  expect(f.submit(3, [], ["unknown"])).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  expect(f.submit(3, [], refs, f.state, "a".repeat(39))).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  const conflicted = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({
      ...a,
      employee_id: id("employee", 1),
    })),
  };
  expect(f.submit(3, [], refs, conflicted)).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  const prior = {
    ...firstReview,
    id: id("review", 2),
    work_item_id: id("work_item", 3),
    delivery_id: id("delivery", 1),
    run_id: id("run", 9),
    issues: [second],
  };
  expect(
    f.submit(3, [], refs, { ...f.state, reviews: [...f.state.reviews, prior] }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining("with proof"),
    },
  });
  const redelivery = await parallelDelivery(f.state, f.io);
  const next = apply(f.state, redelivery);
  expect(
    submitReview(
      next,
      actor(3, "independent_reviewer"),
      {
        delivery_id: redelivery.data.id,
        target_sha: f.target.subject.value,
        kind: "code",
        issues: [],
        issue_refs: refs,
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(f.review(3, []).verdict).toBe("pass");
  expect(f.state.deliveries[0]?.status).toBe("rejected");
  expect(f.state.decisions).toHaveLength(0);
});
