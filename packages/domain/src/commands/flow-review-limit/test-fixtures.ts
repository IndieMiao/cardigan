import {
  type CommandEffect,
  finishRun,
  type ProjectPreferences,
  postComment,
  queueRun,
  submitReview,
} from "../../index.js";
import { command } from "../core.js";
import { reconcileFlowReviewLimits } from "../flow-review-limit.js";
import { mergeFixture } from "../merge/test-fixtures.js";
import { convergent, human } from "../test-fixtures.js";

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

/** Synthetic version 5; deliberately does not change the production version ceiling. */
export function flowReviewFixture(
  max: number | null | undefined = 1,
  version: number | undefined = 5,
) {
  const f = mergeFixture("confirm", 1);
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        {
          collection: "cards",
          entity: { ...required(f.state.cards[0]), flow_version: version },
        },
        {
          collection: "project_preferences",
          entity: {
            id: f.state.project_id,
            auto_merge_after_minutes: null,
            ...(max === undefined
              ? {}
              : { system_review_limit_max_raises: max }),
          } satisfies ProjectPreferences,
        },
      ],
      events: [],
      timeline: [],
      token_requests: [],
    } satisfies CommandEffect<null>,
  });
  const review = (
    target: (typeof f.state.deliveries)[number],
    reject = true,
    category?: string,
    description = "Required check is missing",
    reviewer = f.reviewer,
  ) => {
    f.start(reviewer);
    const { basis, pass_conditions } = convergent(
      f.state,
      required(reviewer.work_item_id),
    );
    return f.commit(
      submitReview(
        f.state,
        f.actor(reviewer),
        {
          delivery_id: target.id,
          target_sha: target.subject.value,
          kind: "code",
          ...(category ? { rejection_category: category } : {}),
          pass_conditions,
          issues: reject
            ? [
                {
                  severity: "critical",
                  impact: "functional" as const,
                  basis,
                  must_fix: true,
                  pre_existing: false,
                  description,
                  proof: "Synthetic check fails",
                },
              ]
            : [],
          recheck_required: true,
        },
        f.io,
      ),
    );
  };
  // C-610: a flow-5 third rejection reaches PM only after a disputed alignment.
  const dispute = (reviewer = f.reviewer) => {
    const verifier = required(reviewer.work_item_id);
    f.start(f.coder);
    const proposal = f.commit(
      postComment(
        f.state,
        f.actor(f.coder),
        {
          card_id: f.card.id,
          body: "Invariants",
          review_alignment: {
            work_item_id: verifier,
            step: "propose",
            invariants: ["Works"],
          },
        },
        f.io,
      ),
    );
    const instruction = required(
      f.state.events.findLast(
        (e) =>
          e.type === "instruction_issued" &&
          (e.payload as { work_item_id?: string }).work_item_id === verifier,
      ),
    );
    const finish = () => {
      for (const r of f.state.runs.filter(
        (r) => r.assignment_id === reviewer.id && r.status === "running",
      ))
        f.commit(
          finishRun(
            f.state,
            f.actor(reviewer),
            { run_id: r.id, outcome: "completed", summary: "Reviewed" },
            f.io,
          ),
        );
    };
    finish();
    f.commit(
      queueRun(
        f.state,
        human,
        {
          assignment_id: reviewer.id,
          model: "fixture-model",
          agent_cli_version: "1",
          trigger_event_id: instruction.id,
        },
        f.io,
      ),
    );
    f.start(reviewer);
    const reply = f.commit(
      postComment(
        f.state,
        f.actor(reviewer),
        {
          card_id: f.card.id,
          body: "Disagree",
          reply_to: required(proposal).id,
          review_alignment: { work_item_id: verifier, step: "dispute" },
        },
        f.io,
      ),
    );
    finish();
    return reply;
  };
  // Exercise future upgrade settlement at its internal seam; the public command
  // must still reject version 5 until its whole release level is enabled.
  const reconcile = () =>
    command(f.state, human, "upgrade_card_flow", f.io, (d) => {
      reconcileFlowReviewLimits(d, f.card.id);
    });
  return { f, review, reconcile, dispute };
}
