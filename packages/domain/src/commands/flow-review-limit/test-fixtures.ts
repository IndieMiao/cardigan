import {
  type CommandEffect,
  type ProjectPreferences,
  submitReview,
} from "../../index.js";
import { command } from "../core.js";
import { reconcileFlowReviewLimits } from "../flow-review-limit.js";
import { mergeFixture } from "../merge/test-fixtures.js";
import { human } from "../test-fixtures.js";

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
    return f.commit(
      submitReview(
        f.state,
        f.actor(reviewer),
        {
          delivery_id: target.id,
          target_sha: target.subject.value,
          kind: "code",
          ...(category ? { rejection_category: category } : {}),
          issues: reject
            ? [
                {
                  severity: "critical",
                  impact: "functional" as const,
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
  // Exercise future upgrade settlement at its internal seam; the public command
  // must still reject version 5 until its whole release level is enabled.
  const reconcile = () =>
    command(f.state, human, "upgrade_card_flow", f.io, (d) => {
      reconcileFlowReviewLimits(d, f.card.id);
    });
  return { f, review, reconcile };
}
