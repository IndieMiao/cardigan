import { expect, test } from "vitest";
import { sharedMustFixes, submitReview, updateWorkItem } from "../index.js";
import { parallelDelivery } from "./parallel-review/test-fixtures.js";
import {
  first,
  sharedReviewFixture as fixture,
  second,
} from "./shared-review/test-fixtures.js";
import { actor, apply, id, value } from "./test-fixtures.js";

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
      f.state.events
        .filter((e) => e.type === "decision_resolved")
        .map((e) => e.payload),
    ).toMatchObject([
      { rework_work_item_id: f.target.work_item_id, resume_work_items: [] },
    ]);
    expect(b.issues.map((i) => i.finding_id).sort()).toEqual(
      a.issues.map((i) => i.finding_id).sort(),
    );
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

test("a resolved raise covers a later exact match, but does not grant a round before its own rejection reaches the limit", async () => {
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
  expect(f.state.runs.filter((r) => r.kind === "decision_resumed")).toEqual([]);
  expect(f.state.runs.find((r) => r.id === id("run", 2))?.status).toBe(
    "running",
  );
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

test("an ordinary raise records only the lane that actually rejected", async () => {
  const f = await fixture();
  f.review(3, []);
  f.review(2, [first]);
  expect(f.decide(2, "raise_limit").ok).toBe(true);
  const q = f.state.decisions[0];
  expect(q?.affected_work_items).toEqual([id("work_item", 2)]);
  expect(q?.resolution?.notice).toBeUndefined();
  expect(q?.resolution?.review_limit_target).toBeUndefined();
  expect(q?.resolution?.proxy_authority).toMatch(
    /decision-delegation|decision_delegation/,
  );
  expect(q?.delegation_authority).toBe(q?.resolution?.proxy_authority);
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 3)),
  ).toMatchObject({ status: "passed", max_review_rounds: 4 });
});

test("a late reviewer can substantiate a new-to-them finding without changing its identity or its author's evidence", async () => {
  const f = await fixture(3, [second]);
  const original = f.review(2, [first]);
  const [ref] = f.refs();
  if (!ref) throw Error("Missing shared issue");
  expect(f.submit(3, [], [ref])).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining("with proof"),
    },
  });
  expect(f.submit(3, [], [{ finding_id: ref, proof: "   " }]).ok).toBe(false);
  const local = {
    finding_id: ref,
    proof: "Observed incorrect result for fixture X",
  };
  expect(f.submit(3, [], [local, ref]).ok).toBe(false);
  const late = f.review(3, [], [local]);
  expect(late.issues).toEqual([{ ...first, ...local }]);
  expect(original.issues[0]?.proof).toBeUndefined();
  expect(f.refs()).toEqual([ref]);
  expect(f.state.decisions).toMatchObject([
    { affected_work_items: [original.work_item_id, late.work_item_id] },
  ]);
});

test("legacy findings without an impact cannot enter a new verdict, directly or by reference", async () => {
  const f = await fixture(0);
  const original = f.review(2, [first]);
  const { impact: _impact, ...legacy } = first;
  const state = { ...f.state, reviews: [{ ...original, issues: [legacy] }] };
  const [entry] = sharedMustFixes(
    state.reviews,
    state.deliveries,
    state.work_items,
  );
  if (!entry) throw Error("Missing legacy finding");
  for (const result of [
    f.submit(3, [legacy], [], state),
    f.submit(3, [], [entry.finding_id], state),
  ])
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: expect.stringContaining("impact"),
      },
    });
  expect(state.reviews[0]?.issues).toEqual([legacy]);
});

test("continuing after a new delivery resumes its reviewers, not the old repair", async () => {
  const f = await fixture();
  f.review(2, [first]);
  f.review(3, [], f.refs());
  expect(f.decide(2, "pause").ok).toBe(true);
  const newer = apply(f.state, await parallelDelivery(f.state, f.io));
  const q = newer.decisions[0];
  if (!q) throw Error("Missing shared pause");
  const continued = value(
    updateWorkItem(
      newer,
      actor(4, "pm"),
      {
        work_item_id: id("work_item", 2),
        review_limit_decision: {
          decision_id: q.id,
          option: "raise_limit",
          rationale: "已核对本次交付",
        },
      },
      f.io,
    ),
  );
  const event = continued.events.find((e) => e.type === "decision_resolved");
  expect(event?.payload).toMatchObject({
    resume_work_items: [id("work_item", 2), id("work_item", 3)],
  });
  expect(event?.payload).not.toHaveProperty("rework_work_item_id");
});
