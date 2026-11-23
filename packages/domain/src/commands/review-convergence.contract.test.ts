import { expect, test } from "vitest";
import {
  type Assignment,
  type Delivery,
  followUpDraft,
  GUARD_PATTERN,
  postComment,
  type ReviewIssue,
  rejectionStreakCards,
  type SubmitReviewParams,
  submitReview,
  type TimelineEntryId,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  flowReviewFixture,
  required,
} from "./flow-review-limit/test-fixtures.js";
import { resumeBlockReason } from "./resumption.js";

const bug = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  severity: "major",
  impact: "functional",
  must_fix: true,
  pre_existing: false,
  description: "Saving reports success but keeps the old value",
  proof: "Reproduced with the fixture",
  ...over,
});
const checklist = [{ description: "Saved value is read back", basis: "AC1" }];

function setup(version = 5) {
  const { f } = flowReviewFixture(undefined, version);
  const verifierId = required(f.reviewer.work_item_id);
  const submit = (
    v: Delivery,
    issues: ReviewIssue[],
    extra: Partial<SubmitReviewParams> = {},
  ) => {
    f.start(f.reviewer);
    return submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: v.id,
        target_sha: v.subject.value,
        kind: "code",
        issues,
        ...extra,
      },
      f.io,
    );
  };
  const review = (
    v: Delivery,
    issues: ReviewIssue[],
    extra: Partial<SubmitReviewParams> = {},
  ) => required(f.commit(submit(v, issues, extra)));
  const verifier = () =>
    required(f.state.work_items.find((w) => w.id === verifierId));
  let sha = 0;
  const deliver = () => f.deliver("code", String(++sha % 10).repeat(40));
  const comment = (
    owner: Assignment,
    step: "propose" | "confirm" | "dispute",
    reply_to?: TimelineEntryId,
  ) =>
    postComment(
      f.state,
      f.actor(owner),
      {
        card_id: f.card.id,
        body: step === "propose" ? "不变量清单" : "回复",
        review_alignment: {
          work_item_id: verifierId,
          step,
          ...(step === "propose"
            ? { invariants: ["保存后重新读取得到新值"] }
            : {}),
        },
        ...(reply_to ? { reply_to } : {}),
      },
      f.io,
    );
  /** Three consecutive rejections, the second with a checklist. */
  const threeRejections = async () => {
    review(await deliver(), [bug({ basis: "AC1" })]);
    review(await deliver(), [bug({ basis: "AC1" })], {
      pass_conditions: checklist,
    });
    return review(await deliver(), [bug({ basis: "PC1" })]);
  };
  return {
    f,
    verifierId,
    submit,
    review,
    verifier,
    deliver,
    comment,
    threeRejections,
  };
}

test("AC1: a must-fix without a basis is a non-blocking follow-up; flow 4 is unchanged", async () => {
  const s = setup();
  const v = await s.deliver();
  const r = s.review(v, [bug()]);
  expect(r.verdict).toBe("pass");
  expect(r.issues[0]).toMatchObject({
    must_fix: false,
    follow_up: { reason: "no_basis" },
  });
  expect(s.f.state.deliveries.find((d) => d.id === v.id)?.status).toBe(
    "accepted",
  );
  expect(s.f.state.timeline.at(-1)?.body).toContain("1 条意见记为后续跟进");
  expect(followUpDraft(s.f.card, s.f.state.reviews)).toMatchObject({
    source_card_id: s.f.card.id,
    items: [{ review_id: r.id, reason: "no_basis" }],
  });

  const old = setup(4);
  expect(old.review(await old.deliver(), [bug()]).verdict).toBe("reject");
});

test("AC1: a cited basis must exist on the card; cited must-fixes keep blocking", async () => {
  const s = setup();
  const v = await s.deliver();
  for (const basis of ["AC2", "INV1", "PC1", "nonsense"])
    expect(s.submit(v, [bug({ basis })])).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  expect(s.review(v, [bug({ basis: "AC1" })]).verdict).toBe("reject");
});

test("AC2: the second rejection needs a checklist; later rounds check only the list", async () => {
  const s = setup();
  s.review(await s.deliver(), [bug({ basis: "AC1" })]);
  const second = await s.deliver();
  expect(s.submit(second, [bug({ basis: "AC1" })])).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("pass_conditions") },
  });
  expect(
    s.submit(second, [bug({ basis: "AC1" })], {
      pass_conditions: [{ description: "Self reference", basis: "PC1" }],
    }).ok,
  ).toBe(false);
  s.review(second, [bug({ basis: "AC1" })], { pass_conditions: checklist });
  const third = await s.deliver();
  const edge = s.review(third, [
    bug({ basis: "AC1", description: "A narrower timing edge" }),
  ]);
  expect(edge.verdict).toBe("pass");
  expect(edge.issues[0]?.follow_up).toEqual({ reason: "outside_checklist" });
});

test("AC2: checklist items, failed checks and lost work still block after the list", async () => {
  for (const basis of ["PC1", "check_failed", "lost_work"]) {
    const s = setup();
    s.review(await s.deliver(), [bug({ basis: "AC1" })]);
    s.review(await s.deliver(), [bug({ basis: "AC1" })], {
      pass_conditions: checklist,
    });
    const r = s.review(await s.deliver(), [bug({ basis })]);
    expect(r.verdict).toBe("reject");
  }
});

test("AC4: guard requests become follow-ups unless they protect work, executors or security", async () => {
  const guard = "核不清提交状态时就停住，交人工确认后再继续";
  for (const [basis, blocking] of [
    ["AC1", false],
    ["lost_work", true],
    ["dual_executor", true],
    ["security", true],
  ] as const) {
    const s = setup();
    const r = s.review(await s.deliver(), [bug({ basis, description: guard })]);
    expect(r.blocking).toBe(blocking);
    if (!blocking) expect(r.issues[0]?.follow_up).toEqual({ reason: "guard" });
  }
});

test("AC3: the third rejection opens an alignment round instead of a PM decision", async () => {
  const s = setup();
  await s.threeRejections();
  expect(s.f.state.decisions).toEqual([]);
  expect(s.verifier()).toMatchObject({
    status: "waiting_decision",
    review_alignment: { status: "open" },
  });
  const opened = required(
    s.f.state.events.findLast((e) => e.type === "instruction_issued"),
  );
  expect(opened.payload).toMatchObject({
    work_item_id: s.f.coder.work_item_id,
    alignment_work_item_id: s.verifierId,
  });
  // The round, not a budget or other path, holds the verifier.
  const d = new CommandDraft(s.f.state, s.f.actor(s.f.coder), "get_card");
  expect(resumeBlockReason(d, s.verifier())).toBe("对齐回合尚未完成");
  expect(s.f.state.events.map((e) => e.type)).toContain(
    "review_alignment_opened",
  );
});

test("AC3: an agreed round records card invariants and resumes review without PM", async () => {
  const s = setup();
  await s.threeRejections();
  s.f.start(s.f.coder);
  const proposal = required(s.f.commit(s.comment(s.f.coder, "propose")));
  // The proposer cannot confirm its own list; replies bind the current proposal.
  expect(s.comment(s.f.coder, "confirm", proposal.id).ok).toBe(false);
  const ask = required(
    s.f.state.events.findLast((e) => e.type === "instruction_issued"),
  );
  expect(ask.payload).toMatchObject({ work_item_id: s.verifierId });
  // Producer redelivers in parallel; the verifier stays parked until agreement.
  const next = await s.deliver();
  expect(s.verifier().status).toBe("waiting_decision");
  s.f.commit(s.comment(s.f.reviewer, "confirm", proposal.id));
  expect(s.f.state.cards[0]?.invariants).toEqual([
    {
      text: "保存后重新读取得到新值",
      work_item_id: s.verifierId,
      entry_id: proposal.id,
    },
  ]);
  expect(s.verifier()).toMatchObject({
    status: "ready",
    review_alignment: { status: "agreed" },
  });
  expect(
    s.f.state.events.findLast((e) => e.type === "review_alignment_agreed")
      ?.payload,
  ).toMatchObject({ delivery_id: next.id, wake: "verifier" });
  // A fourth rejection of the aligned streak continues without PM or a new round.
  const r = s.review(next, [bug({ basis: "INV1" })]);
  expect(r.verdict).toBe("reject");
  expect(s.f.state.decisions).toEqual([]);
  expect(s.verifier().status).toBe("failed");
  expect(s.verifier().review_alignment?.status).toBe("agreed");
});

test("AC3: only a disputed round reaches PM, with the alignment in its context", async () => {
  const s = setup();
  await s.threeRejections();
  s.f.start(s.f.coder);
  const proposal = required(s.f.commit(s.comment(s.f.coder, "propose")));
  s.f.commit(s.comment(s.f.reviewer, "dispute", proposal.id));
  expect(s.verifier().review_alignment?.status).toBe("disputed");
  const q = required(s.f.state.decisions[0]);
  expect(q).toMatchObject({ trigger: "review_limit", status: "open" });
  expect(q.context).toContain(`提案 ${proposal.id}`);
  // A settled round cannot be reopened by comments.
  expect(s.comment(s.f.reviewer, "confirm", proposal.id).ok).toBe(false);
});

test("AC5 metric: cards with three or more consecutive rejections", async () => {
  const s = setup();
  await s.threeRejections();
  const stats = rejectionStreakCards(s.f.state);
  expect(stats).toEqual([
    {
      card_id: s.f.card.id,
      max_streak: 3,
      reached_at: expect.any(String),
    },
  ]);
  const once = setup();
  once.review(await once.deliver(), [bug({ basis: "AC1" })]);
  expect(rejectionStreakCards(once.f.state)).toEqual([]);
});

test("AC4: the guard pattern targets stop requests, not stall bugs", () => {
  for (const text of [
    "核不清提交状态时就停住",
    "改为交人确认后再合并",
    "无法核实时应 fail closed",
    "不确定时拒绝推进",
    "新增人工确认环节",
  ])
    expect(GUARD_PATTERN.test(text), text).toBe(true);
  for (const text of [
    "缺陷会卡住流程",
    "进度条停住不动",
    "保存后丢失数据",
    "只读成员能修改别人的卡片",
  ])
    expect(GUARD_PATTERN.test(text), text).toBe(false);
});
