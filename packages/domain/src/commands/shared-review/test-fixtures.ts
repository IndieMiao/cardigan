import {
  type CommandState,
  type ReviewIssue,
  type SubmitReviewParams,
  sharedMustFixes,
  submitReview,
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
    refs: () =>
      sharedMustFixes(state.reviews, state.deliveries, state.work_items).map(
        (i) => i.finding_id,
      ),
  };
}
