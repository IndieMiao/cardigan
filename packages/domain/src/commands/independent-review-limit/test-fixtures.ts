import {
  type Actor,
  assign,
  createWorkItem,
  type ProjectPreferences,
  standingTools,
  submitReview,
  updateWorkItem,
} from "../../index.js";
import { mergeFixture } from "../merge/test-fixtures.js";
import { fixture, human, ports, role } from "../test-fixtures.js";

export function independentReviewLimitFixture(
  preferences: Partial<ProjectPreferences> = {
    independent_review_limit_delegation: true,
    independent_review_limit_delegation_max: 3,
  },
) {
  const seed = fixture();
  const ops = seed.assignments.find((a) => a.scope === "standing");
  if (!ops) throw new Error("Missing PM");
  const f = mergeFixture("confirm", 5, {
    state: {
      ...seed,
      cards: [],
      work_items: [],
      runs: [],
      roles: [...seed.roles, role("independent_reviewer")],
      assignments: [{ ...ops, standing_mode: "ops" }],
      project_preferences: [
        { id: seed.project_id, auto_merge_after_minutes: null, ...preferences },
      ],
    },
    ports: ports(),
  });
  const pm: Actor = {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: ops.id,
    ...role("pm"),
    allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
  };
  const target = f.coder.work_item_id;
  if (!target) throw new Error("Missing producer");
  const item = f.commit(
    createWorkItem(
      f.state,
      human,
      {
        card_id: f.card.id,
        title: "Independent review",
        kind: "verify",
        role_id: "independent_reviewer",
        required: true,
        completion_criteria: ["Verify boundaries"],
        target_work_item_id: target,
        max_review_rounds: 1,
      },
      f.io,
    ),
  );
  const owner = f.commit(
    assign(
      f.state,
      human,
      { work_item_id: item.id, role_id: item.role_id },
      f.io,
    ),
  );
  const review = (
    delivery: (typeof f.state.deliveries)[number],
    reject = false,
  ) => {
    f.start(owner);
    return f.commit(
      submitReview(
        f.state,
        f.actor(owner),
        {
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: "code",
          issues: [],
          recheck_required: reject,
        },
        f.io,
      ),
    );
  };
  const decision = () => {
    const q = f.state.decisions
      .filter(
        (q) =>
          q.trigger === "review_limit" &&
          q.affected_work_items.includes(item.id),
      )
      .at(-1);
    if (!q) throw new Error("Missing limit decision");
    return q;
  };
  const resolve = (
    option: "raise_limit" | "pause" | "escalate" = "raise_limit",
    actor: Actor = pm,
  ) =>
    updateWorkItem(
      f.state,
      actor,
      {
        work_item_id: item.id,
        review_limit_decision: {
          decision_id: decision().id,
          option,
          rationale: "Check the new delivery",
        },
      },
      f.io,
    );
  const limited = async () => {
    review(await f.deliver());
    return f.deliver("code", "b".repeat(40));
  };
  return { f, pm, item, owner, review, decision, resolve, limited };
}
