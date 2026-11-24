import { expect, test } from "vitest";
import {
  decisionQuestionCurrent,
  hasRunTarget,
  issueInstruction,
  postComment,
  reviewWakeBlocked,
  submitReview,
  type TimelineEntry,
  updateWorkItem,
} from "../index.js";
import { heldReviewer } from "./decision-question/test-fixtures.js";
import { required } from "./flow-review-limit/test-fixtures.js";

test.each(["legacy", "disputed"] as const)(
  "AC1/AC3 %s decision: PM asks the held reviewer, who can answer but cannot review, decide or merge",
  async (path) => {
    const s = await heldReviewer(path);
    const { f, q } = s;
    // An ordinary comment that mentions the reviewer does not lift the wait.
    f.commit(
      postComment(
        f.state,
        s.pm,
        {
          card_id: f.card.id,
          body: "审核员请看一下方案",
          mentions: [f.reviewer.id],
        },
        f.io,
      ),
    );
    const comment = s.lastEvent();
    expect(reviewWakeBlocked(f.state, comment, s.verifierId)).toBe(true);
    expect(s.queue(comment)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });

    const entry = required(f.commit(s.ask())) as TimelineEntry;
    expect(entry).toMatchObject({
      type: "instruction",
      decision_id: q.id,
      work_item_id: s.verifierId,
    });
    const asked = s.lastEvent();
    const latest = required(f.state.deliveries.at(-1));
    expect(asked.payload).toMatchObject({
      work_item_id: s.verifierId,
      decision_id: q.id,
      decision_question: {
        assignment_id: f.reviewer.id,
        delivery_id: latest.id,
        target_sha: latest.subject.value,
      },
    });
    expect(reviewWakeBlocked(f.state, asked, s.verifierId)).toBe(false);
    expect(hasRunTarget(f.reviewer, f.state)).toBe(true);
    const run = required(f.commit(s.queue(asked)));
    f.start(f.reviewer);
    expect(f.state.runs.find((r) => r.id === run.id)?.status).toBe("running");

    // A repeated question never starts a second executor.
    f.commit(s.ask());
    expect(s.queue(s.lastEvent())).toMatchObject({ ok: false });
    expect(
      f.state.runs.filter(
        (r) =>
          r.assignment_id === f.reviewer.id &&
          ["queued", "dispatched", "running"].includes(r.status),
      ),
    ).toHaveLength(1);

    // The answer is a reply; the formal wait and decision are untouched.
    const reply = f.commit(
      postComment(
        f.state,
        f.actor(f.reviewer),
        { card_id: f.card.id, body: "方向同意。", reply_to: entry.id },
        f.io,
      ),
    );
    expect(reply).toMatchObject({ reply_to: entry.id });
    expect(
      submitReview(
        f.state,
        f.actor(f.reviewer),
        {
          delivery_id: latest.id,
          target_sha: latest.subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      updateWorkItem(
        f.state,
        f.actor(f.reviewer),
        {
          work_item_id: s.verifierId,
          review_limit_decision: {
            decision_id: q.id,
            option: "raise_limit",
            rationale: "self-approve",
          },
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(s.verifier().status).toBe("waiting_decision");
    expect(f.state.decisions.find((d) => d.id === q.id)?.status).toBe("open");
    expect(
      f.state.reviews.filter((r) => r.delivery_id === latest.id),
    ).toHaveLength(1);
    s.finish(f.reviewer);

    // PM settles; the normal flow resumes and the old question goes stale.
    f.commit(
      updateWorkItem(
        f.state,
        s.pm,
        {
          work_item_id: s.verifierId,
          review_limit_decision: {
            decision_id: q.id,
            option: "raise_limit",
            rationale: "审核员已确认方向",
          },
        },
        f.io,
      ),
    );
    expect(s.verifier().status).not.toBe("waiting_decision");
    expect(reviewWakeBlocked(f.state, asked, s.verifierId)).toBe(true);
    expect(s.queue(asked).ok).toBe(false);
    expect(s.ask().ok).toBe(false);
    const next = await f.deliver("code", "e".repeat(40));
    f.start(f.reviewer);
    expect(
      submitReview(
        f.state,
        f.actor(f.reviewer),
        {
          delivery_id: next.id,
          target_sha: next.subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ).ok,
    ).toBe(true);
  },
);

test("AC2: only the verifier held by this pending decision can be asked", async () => {
  const s = await heldReviewer("disputed");
  const { f } = s;
  // Not a verifier, not held by it, or no such decision.
  expect(s.ask(required(f.coder.work_item_id))).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect(s.ask(s.verifierId, "Q-999" as never).ok).toBe(false);
  // Only PM Ops or the human may ask.
  expect(
    issueInstruction(
      f.state,
      f.actor(f.coder),
      {
        card_id: f.card.id,
        work_item_id: s.verifierId,
        decision_id: s.q.id,
        body: "请回答",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test("AC2: a new delivery version or another reviewer makes the question stale", async () => {
  const s = await heldReviewer("disputed");
  const { f } = s;
  f.commit(s.ask());
  const asked = s.lastEvent();
  // Reassigning the verifier means the asked reviewer is no longer the one.
  const item = s.verifier();
  const other = { ...item, assignment_id: "A-777" as never };
  expect(decisionQuestionCurrent(item, asked, f.state)).toBe(true);
  expect(decisionQuestionCurrent(other, asked, f.state)).toBe(false);
  // Another card's or another item's event never counts.
  expect(
    decisionQuestionCurrent({ ...item, id: "W-999" as never }, asked, f.state),
  ).toBe(false);
  // The producer submits a new version while the decision is still pending.
  await f.deliver("code", "f".repeat(40));
  expect(s.verifier().status).toBe("waiting_decision");
  expect(reviewWakeBlocked(f.state, asked, s.verifierId)).toBe(true);
  expect(s.queue(asked)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  // A fresh question binds the new version.
  f.commit(s.ask());
  expect(reviewWakeBlocked(f.state, s.lastEvent(), s.verifierId)).toBe(false);
});
