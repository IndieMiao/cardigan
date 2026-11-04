import { expect, test } from "vitest";
import {
  type CardStatus,
  type DecisionStatus,
  type DeliveryStatus,
  deriveAttachmentApproval,
  deriveCardStatus,
  deriveReview,
  deriveReviewMatrix,
  formatId,
  isReviewStale,
  type ReadableIdKind,
  type ReviewIssue,
  type ReviewVerdict,
  type WorkItem,
} from "./index.js";

const id = <K extends ReadableIdKind>(kind: K, n: number) => {
  const result = formatId(kind, n);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const issue = (overrides: Partial<ReviewIssue> = {}): ReviewIssue => ({
  severity: "major",
  description: "finding",
  must_fix: true,
  pre_existing: false,
  ...overrides,
});
const delivery = (
  n = 1,
  value = "head",
  status: DeliveryStatus = "submitted",
) => ({
  id: id("delivery", n),
  subject: { kind: "git_head" as const, value },
  status,
});
const review = (
  n: number,
  d = 1,
  w = 1,
  verdict: ReviewVerdict = "pass",
  sha = "head",
) => ({
  id: id("review", n),
  delivery_id: id("delivery", d),
  work_item_id: id("work_item", w),
  target_sha: sha,
  verdict,
});

test.each([
  [[], false, "pass", false],
  [[issue()], false, "reject", true],
  [[issue({ pre_existing: true })], false, "pass", false],
  [[issue({ must_fix: false })], false, "pass", false],
  [[], true, "conditional", false],
  [[issue({ pre_existing: true })], true, "conditional", false],
  [[issue()], true, "reject", true],
] as const)(
  "derives verdict and blocking for issues=%j recheck=%s",
  (issues, recheck, verdict, blocking) => {
    expect(deriveReview(issues, recheck)).toMatchObject({ verdict, blocking });
  },
);

test("critical findings need nonblank proof; normalization does not mutate input", () => {
  for (const proof of [undefined, "", " \n"]) {
    const input = Object.freeze(
      issue({
        severity: "critical",
        ...(proof === undefined ? {} : { proof }),
      }),
    );
    const result = deriveReview(Object.freeze([input]));
    expect(result.issues[0]?.severity).toBe("major");
    expect(result.verdict).toBe("reject");
    expect(input.severity).toBe("critical");
  }
  expect(
    deriveReview([issue({ severity: "critical", proof: "reproduction" })])
      .issues[0]?.severity,
  ).toBe("critical");
});

test("invariant 14: a new delivery ID, a different subject, or supersession invalidates review", () => {
  expect(isReviewStale(review(1), delivery())).toBe(false);
  expect(isReviewStale(review(1), delivery(2))).toBe(true);
  expect(isReviewStale(review(1), delivery(1, "new-head"))).toBe(true);
  expect(isReviewStale(review(1), delivery(1, "head", "superseded"))).toBe(
    true,
  );
});

test.each([
  ["open", "pending"],
  ["provisional", "pending"],
  ["resolved", "approved"],
  ["withdrawn", "revoked"],
  ["superseded", "revoked"],
  ["revoked", "revoked"],
] as const)(
  "attachment basis %s means %s",
  (status: DecisionStatus, expected) => {
    const basis = id("decision", 1);
    expect(deriveAttachmentApproval({ basis }, [{ key: basis, status }])).toBe(
      expected,
    );
  },
);
test("attachments without a matching decision stay pending", () => {
  expect(deriveAttachmentApproval({}, [])).toBe("pending");
  expect(
    deriveAttachmentApproval({ basis: id("decision", 1) }, [
      { key: id("decision", 2), status: "resolved" },
    ]),
  ).toBe("pending");
});

test("matrix uses numeric review order, matching delivery/verifier/SHA, and empty cells", () => {
  const verifiers = [
    { id: id("work_item", 1), kind: "verify" },
    { id: id("work_item", 2), kind: "verify" },
    { id: id("work_item", 3), kind: "produce" },
  ] as const;
  const reviews = Object.freeze([
    review(10, 1, 1, "reject"),
    review(2),
    review(11, 1, 2, "conditional"),
    review(12, 1, 1, "pass", "wrong-sha"),
    review(13, 1, 99),
  ]);
  const matrix = deriveReviewMatrix(
    [delivery(), delivery(2)],
    verifiers,
    reviews,
  );
  expect(matrix).toHaveLength(4);
  expect(matrix[0]).toMatchObject({
    review_id: id("review", 10),
    verdict: "reject",
  });
  expect(matrix[1]).toMatchObject({
    review_id: id("review", 11),
    verdict: "conditional",
  });
  expect(matrix[2]).toEqual({
    delivery_id: id("delivery", 2),
    work_item_id: id("work_item", 1),
    target_sha: "head",
    verdict: null,
  });
  expect(matrix[3]?.verdict).toBeNull();
  expect(deriveReviewMatrix([], verifiers, reviews)).toEqual([]);
});
test("invariant 14: superseding a delivery invalidates old matrix cells even at the same SHA", () => {
  const verifiers = [{ id: id("work_item", 1), kind: "verify" }] as const;
  const matrix = deriveReviewMatrix(
    [delivery(), { ...delivery(2), supersedes: id("delivery", 1) }],
    verifiers,
    [review(1)],
  );
  expect(matrix.map((cell) => cell.verdict)).toEqual([null, null]);
});

type Item = Pick<WorkItem, "kind" | "status" | "required">;
const doneItems: readonly Item[] = [
  { kind: "produce", status: "accepted", required: true },
  { kind: "verify", status: "passed", required: true },
];
test.each(["backlog", "todo", "done", "cancelled"] as const)(
  "preserves %s without inferred activity",
  (status: CardStatus) => {
    expect(deriveCardStatus(status, [])).toBe(status);
  },
);
test("invariant 13: completed work only derives review, never done", () => {
  expect(deriveCardStatus("in_progress", doneItems)).toBe("review");
  expect(
    deriveCardStatus("in_progress", doneItems, {
      kind: "card_completion",
      status: "accepted",
    }),
  ).toBe("review");
  expect(
    deriveCardStatus("done", [
      { kind: "produce", status: "changes_requested", required: true },
    ]),
  ).toBe("done");
});
test("card middle states follow required production and verification, not optional work", () => {
  const working: Item = {
    kind: "produce",
    status: "in_progress",
    required: true,
  };
  expect(deriveCardStatus("todo", [working])).toBe("in_progress");
  expect(deriveCardStatus("todo", [{ ...working, status: "ready" }])).toBe(
    "todo",
  );
  expect(deriveCardStatus("review", [...doneItems, working])).toBe(
    "in_progress",
  );
  expect(
    deriveCardStatus("in_progress", [{ ...working, status: "delivered" }]),
  ).toBe("review");
  expect(
    deriveCardStatus("review", [
      ...doneItems,
      { kind: "verify", status: "failed", required: true },
    ]),
  ).toBe("in_progress");
  expect(
    deriveCardStatus("in_progress", [
      ...doneItems,
      { ...working, required: false },
    ]),
  ).toBe("review");
});
test("the latest completion submission/rejection takes precedence over work-derived progress", () => {
  const incomplete: Item = {
    kind: "produce",
    status: "in_progress",
    required: true,
  };
  expect(
    deriveCardStatus("in_progress", [incomplete], {
      kind: "card_completion",
      status: "submitted",
    }),
  ).toBe("review");
  expect(
    deriveCardStatus("review", doneItems, {
      kind: "card_completion",
      status: "rejected",
    }),
  ).toBe("in_progress");
});
