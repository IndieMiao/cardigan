import { describe, expect, test } from "vitest";
import {
  assign,
  createWorkItem,
  type Delivery,
  type ReviewIssue,
  submitReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human } from "./test-fixtures.js";

const original: ReviewIssue = {
  severity: "major",
  description: "The original validation bug",
  impact: "functional" as const,
  must_fix: true,
  pre_existing: false,
};
const reproduction =
  "1. Run the validation script with an empty input. 2. Observe exit code 0; expected exit code 1.";
const finding: ReviewIssue = {
  ...original,
  description: "A newly discovered validation bug",
  proof: reproduction,
};

async function followup(role: "reviewer" | "independent_reviewer") {
  const f = mergeFixture("confirm", 2);
  let owner = f.reviewer;
  if (role === "independent_reviewer") {
    if (!f.coder.work_item_id) throw new Error("Missing producer work item");
    const item = f.commit(
      createWorkItem(
        f.state,
        human,
        {
          card_id: f.card.id,
          title: "Independent review",
          kind: "verify",
          role_id: role,
          required: true,
          completion_criteria: ["Verify validation boundaries"],
          target_work_item_id: f.coder.work_item_id,
          max_review_rounds: 2,
        },
        f.io,
      ),
    );
    owner = f.commit(
      assign(f.state, human, { work_item_id: item.id, role_id: role }, f.io),
    );
  }
  const submit = (target: Delivery, issues: ReviewIssue[]) =>
    submitReview(
      f.state,
      f.actor(owner),
      {
        delivery_id: target.id,
        target_sha: target.subject.value,
        kind: "code",
        issues,
      },
      f.io,
    );
  const first = await f.deliver();
  f.start(owner);
  // First-round major findings still need no proof.
  expect(f.commit(submit(first, [original]))).toMatchObject({
    verdict: "reject",
  });
  const next = await f.deliver("code", "b".repeat(40));
  f.start(owner);
  return {
    f,
    owner,
    next,
    submit: (issues: ReviewIssue[]) => submit(next, issues),
  };
}

describe.each(["reviewer", "independent_reviewer"] as const)(
  "C-413: %s follow-up findings",
  (role) => {
    test.each(["major", "critical"] as const)(
      "a new %s with proof rejects the delivery and spends a round",
      async (severity) => {
        const { f, owner, next, submit } = await followup(role);
        const issue = { ...finding, severity };
        expect(f.commit(submit([issue]))).toMatchObject({
          delivery_id: next.id,
          target_sha: next.subject.value,
          verdict: "reject",
          blocking: true,
          issues: [issue],
        });
        expect(
          f.state.work_items.find((w) => w.id === owner.work_item_id),
        ).toMatchObject({
          status: "failed",
          max_review_rounds: 3,
        });
        expect(
          f.state.work_items.find((w) => w.id === f.coder.work_item_id)?.status,
        ).toBe("changes_requested");
        expect(f.state.deliveries.find((d) => d.id === next.id)?.status).toBe(
          "rejected",
        );
        expect(f.state.decisions).toEqual([]);
        expect(
          f.state.reviews.filter(
            (r) =>
              r.work_item_id === owner.work_item_id && r.verdict === "reject",
          ),
        ).toHaveLength(2);
        expect(f.state.events).toContainEqual(
          expect.objectContaining({
            type: "review_limit_raised_by_system",
            payload: expect.objectContaining({
              work_item_id: owner.work_item_id,
              previous_max_review_rounds: 2,
              max_review_rounds: 3,
            }),
          }),
        );
      },
    );

    const { proof: _proof, ...unproven } = finding;
    test.each([
      unproven,
      { ...finding, proof: "" },
      { ...finding, proof: " \n\t " },
      { ...unproven, severity: "critical" },
      { ...finding, severity: "critical", proof: " \n\t " },
      { ...finding, severity: "minor" },
      { ...finding, severity: "minor", must_fix: false },
      { ...finding, must_fix: false },
    ] satisfies ReviewIssue[])(
      "rejects an ineligible new finding: %j",
      async (issue) => {
        const { f, submit } = await followup(role);
        const before = JSON.stringify(f.state);
        expect(submit([issue])).toMatchObject({
          ok: false,
          error: {
            code: "validation_failed",
            message: expect.stringContaining("with proof"),
          },
        });
        expect(JSON.stringify(f.state)).toBe(before);
      },
    );

    test("rechecks a prior issue without requiring new proof", async () => {
      const { f, submit } = await followup(role);
      expect(f.commit(submit([original]))).toMatchObject({
        verdict: "reject",
        issues: [original],
      });
    });

    test("preserves nonblocking historical findings", async () => {
      const { f, submit } = await followup(role);
      const historical = {
        ...unproven,
        severity: "minor" as const,
        pre_existing: true,
      };
      expect(f.commit(submit([historical]))).toMatchObject({
        verdict: "pass",
        blocking: false,
        issues: [historical],
      });
    });
  },
);
