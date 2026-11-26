import { expect, test } from "vitest";
import {
  type Assignment,
  type CommandState,
  type Delivery,
  prepareAttachment,
  type ReviewIssue,
  submitReview,
  uploadAttachment,
  withdrawReview,
} from "../index.js";
import { CommandDraft } from "./core.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { reviewRound } from "./review-round.js";
import { assignment, human, value } from "./test-fixtures.js";

// C-769: the evidence of a delivery reached the card seconds after the
// reviewer read it; the rejection "evidence missing" was then wrong.
const missing: ReviewIssue = {
  severity: "major",
  description: "AC5 证据附件缺失",
  impact: "functional",
  must_fix: true,
  pre_existing: false,
};
const rationale = "开审时读到的卡片早于附件上传，证据其实已到";

async function setup(limit = 3) {
  const f = mergeFixture("confirm", limit);
  const delivery = await f.deliver();
  let n = 0;
  async function upload(attach_to: "delivery" | "comment" = "delivery") {
    n += 1;
    const receipt = value(
      await prepareAttachment(
        n.toString(16).padStart(64, "0"),
        new Uint8Array([n]),
        {
          put: async (sha256) => ({ storage_path: `attachments/${sha256}` }),
          get: async () => undefined,
        },
      ),
    );
    const entry = f.state.timeline.find((e) => e.card_id === f.card.id);
    return f.commit(
      uploadAttachment(
        f.state,
        f.actor(f.coder),
        {
          card_id: f.card.id,
          mime: "image/png",
          kind: "evidence",
          attach_to:
            attach_to === "delivery"
              ? { kind: "delivery", id: delivery.id }
              : { kind: "timeline_entry", id: entry?.id as never },
        },
        receipt,
        f.io,
      ),
    );
  }
  const reject = (
    state: CommandState = f.state,
    evidence_seen?: readonly string[],
    target: Delivery = delivery,
  ) =>
    submitReview(
      state,
      f.actor(f.reviewer),
      {
        delivery_id: target.id,
        target_sha: target.subject.value,
        kind: "code",
        issues: [missing],
        ...(evidence_seen ? { evidence_seen: evidence_seen as never } : {}),
      },
      f.io,
    );
  const status = (id: string) =>
    f.state.work_items.find((w) => w.id === id)?.status;
  const rounds = () =>
    reviewRound(
      new CommandDraft(f.state, f.actor(f.reviewer), "get_card", f.io),
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id) as never,
    );
  return { f, delivery, upload, reject, status, rounds };
}

function pmOps(f: ReturnType<typeof mergeFixture>): Assignment {
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const owner: Assignment = {
    ...base,
    scope: "standing",
    standing_mode: "ops",
  };
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "assignments", entity: owner }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  return owner;
}

test("AC1: a rejection after evidence arrived mid-review is stopped until the reviewer names that evidence", async () => {
  const { f, upload, reject } = await setup();
  f.start(f.reviewer); // reviewer reads the card: no attachment yet
  const late = await upload();
  const onComment = await upload("comment");
  const stopped = reject();
  expect(stopped).toMatchObject({
    ok: false,
    error: { code: "stale_target", message: expect.stringContaining(late.id) },
  });
  if (stopped.ok) throw new Error("unreachable");
  expect(stopped.error.message).toContain(onComment.id);
  expect(stopped.error.message).toContain("证据已更新");
  // Naming only part of the new evidence is still not informed.
  expect(reject(f.state, [late.id])).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  // A pass is never stopped: evidence can only help it.
  expect(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: late.attach_to.id as never,
        target_sha: "a".repeat(40),
        kind: "code",
        issues: [],
      },
      f.io,
    ).ok,
  ).toBe(true);
  // Having re-read the card, the reviewer may still reject, on the record.
  const informed = f.commit(reject(f.state, [late.id, onComment.id]));
  expect(informed).toMatchObject({
    verdict: "reject",
    evidence_seen: [late.id, onComment.id],
  });
});

test("AC2: evidence that is really missing rejects as before and spends a round", async () => {
  const { f, delivery, reject, status, rounds } = await setup();
  f.start(f.reviewer);
  expect(rounds()).toBe(1);
  const review = f.commit(reject());
  expect(review).toMatchObject({ verdict: "reject", blocking: true });
  expect(review.evidence_seen).toBeUndefined();
  expect(rounds()).toBe(2);
  expect(f.state.deliveries.find((v) => v.id === delivery.id)?.status).toBe(
    "rejected",
  );
  expect(status(f.coder.work_item_id as string)).toBe("changes_requested");
  expect(status(f.reviewer.work_item_id as string)).toBe("failed");
  // Nothing arrived late, so the rejection cannot be voided either.
  expect(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});

test("AC2: evidence uploaded before the review started never stops a rejection", async () => {
  const { f, upload, reject } = await setup();
  await upload();
  f.start(f.reviewer);
  expect(f.commit(reject()).verdict).toBe("reject");
});

async function misread() {
  const s = await setup();
  const { f, upload } = s;
  f.start(f.reviewer);
  const late = await upload();
  // Pre-C-769 rejection or a wrong judgement: the reviewer named the file.
  const review = s.f.commit(s.reject(f.state, [late.id]));
  return { ...s, late, review };
}

test("AC3: the reviewer voids a late-evidence rejection; the author need not resubmit and no round is spent", async () => {
  const { f, delivery, late, review, status, rounds } = await misread();
  expect(rounds()).toBe(2);
  const voided = f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ),
  );
  expect(voided).toEqual({
    ...review,
    withdrawn: {
      at: expect.any(String),
      rationale,
      by: `assignment:${f.reviewer.id}`,
      late_evidence: [late.id],
    },
  });
  expect(f.state.reviews.find((r) => r.id === review.id)).toEqual(voided);
  expect(rounds()).toBe(1);
  expect(f.state.deliveries.find((v) => v.id === delivery.id)?.status).toBe(
    "submitted",
  );
  expect(status(f.reviewer.work_item_id as string)).toBe("ready");
  expect(status(f.coder.work_item_id as string)).toBe("delivered");
  const event = f.state.events.at(-1);
  expect(event).toMatchObject({
    type: "review_withdrawn",
    actor: f.actor(f.reviewer),
    payload: {
      review_id: review.id,
      verdict: "reject",
      delivery_id: delivery.id,
      late_evidence: [late.id],
      rationale,
      // The rejecting Run cannot review again, so a new review Run is woken.
      reviewer_needs_run: true,
    },
  });
  expect(f.state.timeline.at(-1)?.body).toContain("作者无需重交");
  // Voiding is one-shot.
  expect(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ).ok,
  ).toBe(false);
  // Same delivery, no resubmission: the reviewer concludes again.
  f.start(f.reviewer);
  const again = f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: delivery.id,
        target_sha: delivery.subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  expect(again.verdict).toBe("pass");
  expect(f.state.deliveries.find((v) => v.id === delivery.id)?.status).toBe(
    "accepted",
  );
  expect(status(f.coder.work_item_id as string)).toBe("accepted");
});

test("AC3: a voided rejection is not counted at the round limit", async () => {
  const { f, review, rounds } = await (async () => {
    const s = await setup(1);
    s.f.start(s.f.reviewer);
    const late = await s.upload();
    return { ...s, review: s.f.commit(s.reject(s.f.state, [late.id])) };
  })();
  expect(rounds()).toBe(2);
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ),
  );
  expect(rounds()).toBe(1);
  // The new review Run starts within the round limit.
  f.start(f.reviewer);
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
  ).toBe("in_progress");
});

test("AC3: PM Ops may void it; the author, other assignments and the human may not", async () => {
  const { f, review, status } = await misread();
  const params = { work_item_id: review.work_item_id, rationale };
  for (const caller of [f.actor(f.coder), f.actor(f.pm), human])
    expect(withdrawReview(f.state, caller, params, f.io).ok).toBe(false);
  const ops = pmOps(f);
  const voided = f.commit(withdrawReview(f.state, f.actor(ops), params, f.io));
  expect(voided.withdrawn?.by).toBe(`assignment:${ops.id}`);
  expect(f.state.timeline.at(-1)?.body).toContain("常驻 PM");
  expect(status(f.reviewer.work_item_id as string)).toBe("ready");
});

test("AC3: PM Ops still cannot withdraw a pass", async () => {
  const f = mergeFixture("confirm");
  const delivery = await f.deliver();
  const review = f.review(delivery);
  const ops = pmOps(f);
  expect(
    withdrawReview(
      f.state,
      f.actor(ops),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("AC3: once the author resubmitted, the old rejection cannot be voided", async () => {
  const { f, review } = await misread();
  await f.deliver("code", "b".repeat(40));
  expect(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ).ok,
  ).toBe(false);
});

test("AC3: evidence uploaded after the rejection does not make it voidable", async () => {
  const { f, upload, reject } = await setup();
  f.start(f.reviewer);
  const review = f.commit(reject());
  await upload();
  expect(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});
