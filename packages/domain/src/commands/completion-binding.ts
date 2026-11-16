import { deriveReviewMatrix } from "../derived.js";
import type { Card, Delivery } from "../entities.js";
import { highRiskProducts } from "../high-risk.js";
import { hasProbeEvidence } from "../probes.js";
import { isCompletionVerifier } from "../templates.js";
import { attempt, type CommandDraft, ensure } from "./core.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { canonical } from "./review-context.js";
import { resolveCardTemplate } from "./templates.js";
import { workCompleted } from "./workflow.js";

/** Fresh, non-waivable product checks. Completion reviewers are deliberately excluded. */
export function completionSources(d: CommandDraft, card: Card) {
  const template = resolveCardTemplate(d, card);
  const items = d
    .list("work_items")
    .filter((w) => w.card_id === card.id && !w.replaced_by_work_item_id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const verifiers = items.filter((w) => isCompletionVerifier(template, w));
  const products = items
    .filter((w) => w.kind === "produce")
    .flatMap((w) => {
      const latest = d
        .list("deliveries")
        .filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      // An optional item with no current output contributes nothing to the candidate.
      if (!w.required && !latest) return [];
      // The existing merge candidate selector includes accepted deliveries of
      // cancelled optional producers too. Keep that actual set fully bound.
      if (w.status === "cancelled" && latest?.status !== "accepted") return [];
      ensure(
        latest?.status === "accepted",
        "invariant_violation",
        `产出项 ${w.id} 缺少当前已通过交付`,
      );
      return [latest];
    });
  ensure(products.length, "invariant_violation", "没有当前产出交付");
  if (card.template === "integration" && card.template_version === 1)
    for (const product of products)
      ensure(
        product.subject.kind === "git_head" &&
          hasProbeEvidence(
            d.state.events,
            {
              project_id: d.state.project_id,
              card_id: card.id,
              work_item_id: product.work_item_id,
            },
            product.subject.value,
            product.attachments,
          ),
        "invariant_violation",
        "集成完成申请缺少当前版本真实冒烟证据",
      );
  for (const w of items.filter(
    (w) => w.required && !verifiers.some((v) => v.id === w.id),
  ))
    ensure(
      workCompleted(w),
      "invariant_violation",
      `必需工作项 ${w.id} 尚未通过`,
    );
  const matrix = deriveReviewMatrix(products, items, d.list("reviews"));
  const reviews = matrix.flatMap((row) => {
    const w = d.work(row.work_item_id);
    if (!w.required || w.replaced_by_work_item_id) return [];
    ensure(
      w.status === "passed" && row.verdict === "pass" && row.review_id,
      "invariant_violation",
      `必需验证项 ${w.id} 尚未对当前交付通过`,
    );
    const review = d.get("reviews", row.review_id);
    ensure(
      !review.blocking &&
        !review.recheck_required &&
        !review.issues.some((i) => i.must_fix && !i.pre_existing),
      "invariant_violation",
      `审核 ${review.id} 仍有必改问题`,
    );
    const owner = d.get(
      "assignments",
      d.get("runs", review.run_id).assignment_id,
    );
    ensure(
      owner.scope === "work_item" && owner.work_item_id === w.id,
      "invariant_violation",
      "审核来源不属于验证项",
    );
    checkEmployeeSeparation(
      d,
      w,
      owner.employee_id,
      d.get("deliveries", review.delivery_id),
    );
    return [review];
  });
  // Required orphan verifiers cannot be satisfied by an unrelated pass/status.
  for (const w of items.filter(
    (w) =>
      w.kind === "verify" &&
      w.required &&
      !verifiers.some((v) => v.id === w.id),
  ))
    ensure(
      reviews.some((r) => r.work_item_id === w.id),
      "invariant_violation",
      `必需验证项 ${w.id} 缺少当前审核`,
    );
  if (
    highRiskProducts(
      {
        project_id: d.state.project_id,
        project_preferences: d.list("project_preferences"),
        work_items: d.list("work_items"),
        deliveries: d.list("deliveries"),
      },
      card,
    ).length &&
    template.completion.mode === "review" &&
    template.completion.reviewer !== "human"
  )
    for (const product of products.filter((v) =>
      highRiskProducts(
        {
          project_id: d.state.project_id,
          project_preferences: d.list("project_preferences"),
          work_items: items,
          deliveries: d.list("deliveries"),
        },
        card,
      ).some((w) => w.id === v.work_item_id),
    ))
      ensure(
        items.some(
          (w) =>
            w.kind === "verify" &&
            w.role_id === "independent_reviewer" &&
            w.required &&
            w.status === "passed" &&
            w.target_work_item_id === product.work_item_id &&
            reviews.some((r) => r.work_item_id === w.id),
        ),
        "invariant_violation",
        "风险卡缺少对当前产出的必需有效独立复核",
      );
  const binding = canonical({
    products: products.map((v) => [v.id, v.subject]),
    reviews: reviews.map((r) => r.id),
    requirements: items.map((w) => [
      w.id,
      w.kind,
      w.required,
      w.role_id,
      w.kind === "verify" ? w.target_work_item_id : null,
      w.completion_criteria,
      w.status === "cancelled",
    ]),
    identities: d
      .list("assignments")
      .filter(
        (a) =>
          a.scope === "work_item" &&
          items.some(
            (w) =>
              w.id === a.work_item_id && !verifiers.some((v) => v.id === w.id),
          ),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => [a.id, a.role_id, a.employee_id]),
    high_risk: card.high_risk === true,
    acceptance_criteria: card.acceptance_criteria,
    template: [
      template.id,
      template.version,
      template.completion,
      template.work_items,
    ],
  });
  return { products, reviews, verifiers, binding };
}

export function systemCompletionCurrent(
  d: CommandDraft,
  card: Card,
  delivery: Delivery,
) {
  if (!delivery.system_completion) return true;
  const result = attempt(() => completionSources(d, card));
  return (
    result.ok && result.value.binding === delivery.system_completion.binding
  );
}

/** Missing coverage is configuration work for Ops, not an ordinary pending review. */
export function missingIndependentReview(d: CommandDraft, card: Card): boolean {
  const template = resolveCardTemplate(d, card);
  if (
    !highRiskProducts(
      {
        project_id: d.state.project_id,
        project_preferences: d.list("project_preferences"),
        work_items: d.list("work_items"),
        deliveries: d.list("deliveries"),
      },
      card,
    ).length ||
    template.completion.mode !== "review" ||
    template.completion.reviewer === "human"
  )
    return false;
  const items = d
    .list("work_items")
    .filter((w) => w.card_id === card.id && !w.replaced_by_work_item_id);
  const highRisk = highRiskProducts(
    {
      project_id: d.state.project_id,
      project_preferences: d.list("project_preferences"),
      work_items: items,
      deliveries: d.list("deliveries"),
    },
    card,
  );
  return items
    .filter(
      (w) =>
        w.kind === "produce" &&
        highRisk.some((p) => p.id === w.id) &&
        (w.status !== "cancelled" ||
          d
            .list("deliveries")
            .some(
              (v) =>
                v.work_item_id === w.id &&
                v.kind !== "card_completion" &&
                v.status === "accepted",
            )),
    )
    .some(
      (product) =>
        !items.some(
          (w) =>
            w.kind === "verify" &&
            w.required &&
            w.role_id === "independent_reviewer" &&
            w.status !== "cancelled" &&
            w.target_work_item_id === product.id,
        ),
    );
}
