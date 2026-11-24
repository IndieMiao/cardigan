import {
  type CommandEffect,
  type CommandState,
  postComment,
  type Result,
  type ReviewIssue,
  type SubmitReviewParams,
  sharedMustFixes,
  submitReview,
  type TimelineEntryId,
  updateWorkItem,
} from "../../index.js";
import {
  parallelBug,
  parallelDelivery,
  parallelState,
} from "../parallel-review/test-fixtures.js";
import { actor, apply, id, ports, role, value } from "../test-fixtures.js";

export const first = parallelBug;
export const second = {
  ...first,
  description: "A second missing check",
  proof: "Reproduced with another fixture",
};
export async function sharedReviewFixture(
  prior = 3,
  independentPrior: ReviewIssue[] = [first, second],
  independentRounds = prior,
) {
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
      Array.from({ length: n === 3 ? independentRounds : prior }, (_, k) => ({
        id: id("review", n * 10 + k),
        work_item_id: id("work_item", n),
        delivery_id: id("delivery", k + 1),
        target_sha: "b".repeat(40),
        run_id: id("run", n * 10 + k),
        kind: "code" as const,
        issues: n === 3 ? independentPrior : [first, second],
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
    refs: SubmitReviewParams["issue_refs"] = [],
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
        pass_conditions: [{ description: "Validation exists", basis: "AC1" }],
      },
      io,
    );
  function review(
    n: number,
    issues: ReviewIssue[],
    refs: SubmitReviewParams["issue_refs"] = [],
  ) {
    const result = value(submit(n, issues, refs));
    state = apply(state, result);
    return result.data;
  }
  function comment(
    n: number,
    step: "propose" | "confirm",
    reply_to?: TimelineEntryId,
  ) {
    const q = state.decisions[0];
    if (!q?.card_id) throw Error("Missing pause");
    const effect = value(
      postComment(
        state,
        n === 1 ? actor() : who(n),
        {
          card_id: q.card_id,
          body: n === 1 ? "提交状态与证据表" : "确认表中状态与证据",
          review_plan: { decision_id: q.id, step },
          ...(reply_to ? { reply_to } : {}),
        },
        io,
      ),
    );
    state = apply(state, effect);
    if (!effect.data) throw Error("Missing proposal comment");
    return effect.data;
  }
  function confirmPause() {
    const p = comment(1, "propose");
    comment(2, "confirm", p.id);
    comment(3, "confirm", p.id);
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
          ...(option === "pause"
            ? {
                pause_plan: {
                  owner: id("assignment", 1),
                  confirmers: [id("assignment", 2), id("assignment", 3)],
                  next_step: "提交状态与证据表",
                },
              }
            : {}),
        },
      },
      io,
    );
    if (result.ok) state = apply(state, result.value);
    return result;
  }
  function act<T>(run: (s: CommandState) => Result<CommandEffect<T>>) {
    const effect = value(run(state));
    state = apply(state, effect);
    return effect.data;
  }
  return {
    act,
    comment,
    confirmPause,
    submit,
    review,
    decide,
    target,
    io,
    get state() {
      return state;
    },
    refs: () =>
      sharedMustFixes(state.reviews, state.deliveries, state.work_items).map(
        (i) => i.finding_id,
      ),
  };
}
