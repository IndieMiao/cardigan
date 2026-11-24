import { expect, test } from "vitest";
import {
  type Actor,
  type Attachment,
  type AttachmentId,
  type Card,
  createCard,
  type Delivery,
  type Event,
  type EvidencePending,
  outstandingEvidence,
  type ReviewIssue,
  rejectionStreakEpisodes,
  type SubmitReviewParams,
  submitReview,
  systemCompleteCard,
  verificationActivity,
  verificationTarget,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  flowReviewFixture,
  required,
} from "./flow-review-limit/test-fixtures.js";
import { rejectionStreak, reviewRound } from "./review-round.js";
import { human } from "./test-fixtures.js";
import { resumeWorkWaits } from "./work-waits.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const bug = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  severity: "major",
  impact: "functional",
  must_fix: true,
  pre_existing: false,
  description: "Saving reports success but keeps the old value",
  proof: "Reproduced with the fixture",
  basis: "AC1",
  ...over,
});
const checklist = [{ description: "Saved value is read back", basis: "AC1" }];

function setup(version = 5) {
  const { f } = flowReviewFixture(undefined, version);
  const platform = required(
    f.commit(
      createCard(
        f.state,
        human,
        {
          title: "Platform entry",
          goal: "Fix the managed entry",
          acceptance_criteria: ["Entry works"],
          source: { kind: "quote", text: "Platform" },
          repo: "fixture",
          base_branch: "main",
        },
        f.io,
      ),
    ),
  );
  const verifierId = required(f.reviewer.work_item_id);
  const pending = (
    blocker: EvidencePending["blocker"] = {
      kind: "card_merged",
      target_id: platform.id,
    },
  ) => ({
    items: [{ description: "Simulator run of the flow", basis: "AC1" }],
    blocker,
  });
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
  const draft = () => new CommandDraft(f.state, f.actor(f.coder), "get_card");
  const verifier = () =>
    required(f.state.work_items.find((w) => w.id === verifierId));
  const delivery = (id: string) =>
    required(f.state.deliveries.find((v) => v.id === id));
  let sha = 0;
  const deliver = () => f.deliver("code", String(++sha % 10).repeat(40));
  const setCard = (card: Card, extra: Event[] = []) =>
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [{ collection: "cards", entity: card }],
        events: extra,
        timeline: [],
        token_requests: [],
      },
    });
  /** The platform card merges with a trusted system record. */
  const mergePlatform = () => {
    const card = required(f.state.cards.find((c) => c.id === platform.id));
    setCard({ ...card, status: "done" }, [
      {
        id: f.io.ids.nextEventId(),
        seq: f.io.ids.nextEventSequence(f.state.project_id, platform.id),
        type: "card_merged",
        payload: { merge_sha: "f".repeat(40) },
        actor: system,
        card_id: platform.id,
        created_at: f.io.clock.now(),
      },
    ]);
  };
  const attach = (to: Attachment["attach_to"], n: number): AttachmentId => {
    const id = `A-${900 + n}` as AttachmentId;
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [
          {
            collection: "attachments",
            entity: {
              id,
              sha256: String(n).repeat(64).slice(0, 64),
              mime: "text/plain",
              size: 1,
              card_id: f.card.id,
              uploaded_by: `assignment:${f.coder.id}`,
              storage_path: `fixture/${id}`,
              attach_to: to,
              kind: "evidence",
            } as Attachment,
          },
        ],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    return id;
  };
  const scan = () =>
    required(f.commit(resumeWorkWaits(f.state, system, {}, f.io)));
  const unblocked = () =>
    f.state.events.filter((e) => e.type === "review_evidence_unblocked");
  const complete = () =>
    f.commit(systemCompleteCard(f.state, system, { card_id: f.card.id }, f.io));
  return {
    f,
    platform,
    verifierId,
    pending,
    submit,
    review,
    draft,
    verifier,
    delivery,
    deliver,
    setCard,
    mergePlatform,
    attach,
    scan,
    unblocked,
    complete,
  };
}

test("AC1: pending platform evidence is a non-passing conditional that spends no round and wakes nobody", async () => {
  const s = setup();
  const v = await s.deliver();
  const r = s.review(v, [], { evidence_pending: s.pending() });
  expect(r).toMatchObject({
    verdict: "conditional",
    blocking: false,
    recheck_required: false,
    evidence_pending: {
      items: [{ description: "Simulator run of the flow", basis: "AC1" }],
      blocker: { kind: "card_merged", target_id: s.platform.id },
    },
  });
  expect(s.delivery(v.id).status).toBe("submitted");
  expect(s.verifier().status).toBe("in_progress");
  expect(reviewRound(s.draft(), s.verifier())).toBe(1);
  const event = required(
    s.f.state.events.findLast((e) => e.type === "review_submitted"),
  );
  expect(event.payload).toMatchObject({
    verdict: "conditional",
    rework_allowed: false,
    evidence_pending: { blocker: { target_id: s.platform.id } },
  });
  expect(s.f.state.timeline.at(-1)?.body).toContain("证据待补 1 项");
  // The verifier waits for a new delivery instead of re-reviewing this one.
  expect(verificationTarget(s.verifier(), s.f.state)).toBeUndefined();
  expect(verificationActivity(s.verifier(), s.f.state)).toMatchObject({
    status: "waiting_delivery",
    label: "证据待补",
  });
  expect(outstandingEvidence(s.f.state.reviews, s.verifierId)?.id).toBe(r.id);
});

test("AC1: an evidence wait keeps the existing rejection streak instead of resetting it", async () => {
  const s = setup();
  s.review(await s.deliver(), [bug()]);
  s.review(await s.deliver(), [], { evidence_pending: s.pending() });
  expect(rejectionStreak(s.draft(), s.verifier())).toHaveLength(1);
  // Still the second consecutive rejection: the checklist is required.
  const missing = s.submit(await s.deliver(), [bug()]);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.message).toContain("pass_conditions");
  s.review(required(s.f.state.deliveries.at(-1)), [bug()], {
    pass_conditions: checklist,
  });
  s.review(await s.deliver(), [], { evidence_pending: s.pending() });
  // The third rejection still opens the alignment round across both waits.
  s.review(await s.deliver(), [bug({ basis: "PC1" })]);
  expect(s.verifier().review_alignment?.status).toBe("open");
  expect(reviewRound(s.draft(), s.verifier())).toBe(4);
  const episodes = rejectionStreakEpisodes(s.f.state);
  expect(episodes).toHaveLength(1);
  expect(episodes[0]?.max_streak).toBe(3);
});

test("AC1: a real code must-fix next to pending evidence is still a counted rejection", async () => {
  const s = setup();
  const v = await s.deliver();
  const r = s.review(v, [bug()], { evidence_pending: s.pending() });
  expect(r).toMatchObject({ verdict: "reject", blocking: true });
  expect(r.evidence_pending?.items).toHaveLength(1);
  expect(s.delivery(v.id).status).toBe("rejected");
  expect(reviewRound(s.draft(), s.verifier())).toBe(2);
  expect(rejectionStreak(s.draft(), s.verifier())).toHaveLength(1);
  const event = required(
    s.f.state.events.findLast((e) => e.type === "review_submitted"),
  );
  expect(event.payload).toMatchObject({ rework_allowed: true });
  expect(s.f.state.timeline.at(-1)?.body).toContain("另有证据待补 1 项");
});

test("AC2: without a checkable, unresolved platform blocker the existing review flow applies", async () => {
  const s = setup();
  const v = await s.deliver();
  const rejected = (
    pending: unknown,
    extra: Partial<SubmitReviewParams> = {},
  ) => {
    const r = s.submit(v, [], {
      evidence_pending: pending as EvidencePending,
      ...extra,
    });
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error.message;
  };
  expect(
    rejected(s.pending({ kind: "card_merged", target_id: "C-999" })),
  ).toContain("不是可核查的平台阻塞");
  expect(
    rejected(s.pending({ kind: "card_merged", target_id: s.f.card.id })),
  ).toContain("不是可核查的平台阻塞");
  expect(
    rejected(s.pending({ kind: "deployment_ready", target_id: "abc" })),
  ).toContain("40 位");
  expect(
    rejected({
      ...s.pending(),
      blocker: { kind: "decision_resolved", target_id: "Q-1" },
    }),
  ).toContain("平台阻塞须为");
  expect(
    rejected({
      ...s.pending(),
      items: [{ description: "Tests pass", basis: "check_failed" }],
    }),
  ).toContain("验收标准");
  expect(rejected({ ...s.pending(), items: [] })).toContain("1–10");
  expect(rejected(s.pending(), { recheck_required: true })).toContain(
    "recheck_required",
  );
  // A merged or cancelled platform card is no longer a blocker.
  const platform = required(
    s.f.state.cards.find((c) => c.id === s.platform.id),
  );
  s.setCard({ ...platform, status: "cancelled" });
  expect(rejected(s.pending())).toContain("已取消");
  s.setCard({ ...platform, status: "done" });
  expect(rejected(s.pending())).toContain("已完成");
  // Nothing was recorded; the verifier still reviews normally.
  expect(s.f.state.reviews).toHaveLength(0);
  expect(s.review(v, []).verdict).toBe("pass");
});

test("AC2: flow 4 cards keep the existing review contract", async () => {
  const s = setup(4);
  const r = s.submit(await s.deliver(), [], { evidence_pending: s.pending() });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.message).toContain("流程版本");
});

test("AC2/AC3: pending evidence is not a pass; resolution notifies the author once and a pass needs version-bound evidence", async () => {
  const s = setup();
  const first = await s.deliver();
  const waiting = s.review(first, [], { evidence_pending: s.pending() });
  // Unresolved: no notice, no completion, verifier waits.
  s.scan();
  expect(s.unblocked()).toHaveLength(0);
  expect(s.complete()).toBeNull();
  s.mergePlatform();
  s.scan();
  s.scan();
  expect(s.unblocked()).toHaveLength(1);
  expect(s.unblocked()[0]?.payload).toMatchObject({
    work_item_id: s.f.coder.work_item_id,
    review_ids: [waiting.id],
    verifier_work_item_ids: [s.verifierId],
    condition: { kind: "card_merged", target_id: s.platform.id },
  });
  const instructions = s.f.state.events.filter(
    (e) =>
      e.type === "instruction_issued" &&
      (e.payload as { evidence_unblocked?: unknown }).evidence_unblocked,
  );
  expect(instructions).toHaveLength(1);
  expect(instructions[0]?.payload).toMatchObject({
    work_item_id: s.f.coder.work_item_id,
  });
  expect(
    s.f.state.timeline.findLast((t) => t.type === "instruction")?.body,
  ).toContain("Simulator run of the flow");
  // The author supplies evidence on a new delivery.
  const stale = s.attach({ kind: "delivery", id: first.id }, 1);
  const second = await s.deliver();
  const bound = s.attach({ kind: "delivery", id: second.id }, 2);
  const unsettled = s.submit(second, []);
  expect(unsettled.ok).toBe(false);
  if (!unsettled.ok)
    expect(unsettled.error.message).toContain("证据待补不等于通过");
  const old = s.submit(second, [], { evidence_attachments: [stale] });
  expect(old.ok).toBe(false);
  if (!old.ok) expect(old.error.message).toContain("旧版本证据不能沿用");
  // The resolved blocker cannot be cited again.
  const again = s.submit(second, [], { evidence_pending: s.pending() });
  expect(again.ok).toBe(false);
  const passed = s.review(second, [], { evidence_attachments: [bound] });
  expect(passed).toMatchObject({
    verdict: "pass",
    evidence_attachments: [bound],
  });
  expect(s.delivery(second.id).status).toBe("accepted");
  expect(outstandingEvidence(s.f.state.reviews, s.verifierId)).toBeUndefined();
  // The system completion request follows only the settled pass.
  expect(s.complete()).toMatchObject({
    kind: "card_completion",
    subject: second.subject,
  });
  s.scan();
  expect(s.unblocked()).toHaveLength(1);
});

test("AC3: code rejections carry pending evidence; a stated reason settles evidence that no longer applies", async () => {
  const s = setup();
  s.review(await s.deliver(), [], { evidence_pending: s.pending() });
  s.review(await s.deliver(), [bug()]);
  expect(outstandingEvidence(s.f.state.reviews, s.verifierId)?.verdict).toBe(
    "conditional",
  );
  const v = await s.deliver();
  const extra = s.submit(v, [bug({ description: "New", basis: "AC1" })], {
    pass_conditions: checklist,
    evidence_not_applicable: "",
  });
  expect(extra.ok).toBe(false);
  const passed = s.review(v, [], {
    evidence_not_applicable: "The simulator step was removed from this flow",
  });
  expect(passed.verdict).toBe("pass");
  expect(s.f.state.timeline.at(-1)?.body).toContain("待补证据已不适用");
  // Settlement fields need something pending.
  const next = await s.deliver();
  const stray = s.submit(next, [], { evidence_not_applicable: "Nothing" });
  expect(stray.ok).toBe(false);
});

test("AC3: deployment blockers settle from trusted deployment records only", async () => {
  const s = setup();
  const sha = "e".repeat(40);
  s.review(await s.deliver(), [], {
    evidence_pending: s.pending({ kind: "deployment_ready", target_id: sha }),
  });
  s.scan();
  expect(s.unblocked()).toHaveLength(0);
  s.f.commit({
    ok: true,
    value: {
      data: null,
      changes: [],
      events: [
        {
          id: s.f.io.ids.nextEventId(),
          seq: s.f.io.ids.nextEventSequence(s.f.state.project_id),
          type: "host_deployment_recorded",
          payload: { to: sha, status: "deployed", ready: true },
          actor: system,
          created_at: s.f.io.clock.now(),
        } as Event,
      ],
      timeline: [],
      token_requests: [],
    },
  });
  s.scan();
  s.scan();
  expect(s.unblocked()).toHaveLength(1);
});
