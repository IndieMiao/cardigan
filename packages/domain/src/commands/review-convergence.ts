import type {
  Card,
  PassCondition,
  ReviewIssue,
  WorkItem,
} from "../entities.js";
import { flowAtLeast } from "../flow.js";
import {
  activeChecklist,
  basisProblem,
  convergeIssues,
  MAX_PASS_CONDITIONS,
} from "../review-convergence.js";
import type { ReviewVerdict } from "../states.js";
import { type CommandDraft, ensure } from "./core.js";
import { rejectionStreak } from "./review-round.js";

/** C-610 (flow >= 5): cited bases are validated; the rest become follow-ups. */
export function convergeSubmittedIssues(
  d: CommandDraft,
  card: Card,
  item: WorkItem,
  direct: readonly ReviewIssue[],
  issues: readonly ReviewIssue[],
): readonly ReviewIssue[] {
  if (!flowAtLeast(card, 5)) return issues;
  const checklist = activeChecklist(rejectionStreak(d, item));
  for (const issue of direct) {
    if (issue.basis === undefined) continue;
    const problem = basisProblem(card, issue.basis, checklist);
    ensure(!problem, "validation_failed", problem ?? "");
  }
  return convergeIssues(card, issues, checklist);
}

/** C-610: the second consecutive rejection of a streak fixes its checklist. */
export function reviewPassConditions(
  d: CommandDraft,
  card: Card,
  item: WorkItem,
  verdict: ReviewVerdict,
  input: unknown,
): readonly PassCondition[] | undefined {
  if (!flowAtLeast(card, 5) || verdict !== "reject") return;
  const streak = rejectionStreak(d, item);
  if (input === undefined) {
    ensure(
      streak.length !== 1 || !!activeChecklist(streak),
      "validation_failed",
      `同一验证项第 2 次驳回须带 pass_conditions：1–${MAX_PASS_CONDITIONS} 条可验证的通过条件，每条写 description 和 basis；下一轮只核对这份清单`,
    );
    return;
  }
  ensure(
    Array.isArray(input) &&
      input.length > 0 &&
      input.length <= MAX_PASS_CONDITIONS,
    "validation_failed",
    `pass_conditions 须为 1–${MAX_PASS_CONDITIONS} 条`,
  );
  return input.map((c: unknown) => {
    const condition = c as Partial<PassCondition> | null;
    ensure(
      typeof condition?.description === "string" &&
        condition.description.trim().length > 0 &&
        condition.description.trim().length <= 500,
      "validation_failed",
      "每条通过条件须写 1–500 字的 description",
    );
    const problem = basisProblem(card, condition.basis, undefined, false);
    ensure(!problem, "validation_failed", `通过条件的 ${problem}`);
    return {
      description: condition.description.trim(),
      basis: String(condition.basis).trim(),
    };
  });
}
