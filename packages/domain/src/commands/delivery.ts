import {
  deriveCardStatus,
  deriveReview,
  isReviewStale,
  reviewPassed,
} from "../derived.js";
import type {
  Actor,
  Assignment,
  Delivery,
  DeliveryEvidence,
  DeliverySubject,
  Review,
  WorkItem,
} from "../entities.js";
import { REVIEW_IMPACTS } from "../entities.js";
import type { Result } from "../errors.js";
import { flowAtLeast } from "../flow.js";
import type { DeliveryVerifier } from "../ports.js";
import { reviewMaxRounds } from "../preferences.js";
import { hasProbeEvidence } from "../probes.js";
import { isCompletionVerifier } from "../templates.js";
import type { TestReviewProof } from "../test-review.js";
import { transition } from "../transitions.js";
import { isHttpUrl } from "../url.js";
import { applyDeliveryAutoRiskTags } from "./auto-risk-tags.js";
import { requireCardDependencies } from "./card-dependencies.js";
import {
  missingIndependentReview,
  systemCompletionCurrent,
} from "./completion-binding.js";
import {
  attempt,
  CommandDraft,
  type CommandPorts,
  type CommandState,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { supersedeDelivery } from "./delivery-invalidation.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { upgradeFastPatch } from "./fast-patch.js";
import { requestHumanCompletionReview } from "./human-completion.js";
import { completionPassed } from "./merge.js";
import { buildPlainSummary } from "./plain-summary.js";
import {
  projectIndependentReviewCheck,
  projectScreenshotCheck,
  reuseIndependentReviewCheck,
} from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import { pendingReviewLimit, requestReviewLimit } from "./review-limit.js";
import {
  deliveryTree,
  reusableReviews,
  reviewReuseContext,
} from "./review-reuse.js";
import {
  conflictRepairEvent,
  reviewRejectionsNeedAttention,
} from "./review-round.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";
import { resolveCardTemplate } from "./templates.js";
import {
  incrementalTestReview,
  invalidTestReviewPasses,
  testReviewCandidate,
} from "./test-review.js";
import { activeWork, reviewRound, workCompleted } from "./workflow.js";

export type SubmitDeliveryParams = Pick<
  Delivery,
  "work_item_id" | "kind" | "summary" | "subject" | "requested_verifiers"
> &
  Partial<
    Pick<
      Delivery,
      | "branch"
      | "pr_url"
      | "test_results"
      | "attachments"
      | "known_gaps"
      | "supersedes"
      | "plain_summary"
    >
  >;
const sameSubject = (a: DeliverySubject, b: DeliverySubject) =>
  a.kind === b.kind && a.value === b.value;
function inspect(d: CommandDraft, p: SubmitDeliveryParams) {
  const system = d.actor.kind === "system" && d.tool === "system_complete_card";
  const item = system ? d.work(p.work_item_id) : d.ownWork(p.work_item_id);
  checkEmployeeSeparation(d, item, d.assignment?.employee_id);
  ensure(
    item.kind === "produce",
    "unauthorized",
    "Only a producing assignment can deliver",
  );
  const card = d.card(item.card_id);
  ensure(
    !["done", "cancelled", "awaiting_merge"].includes(card.status),
    "illegal_transition",
    "Card is closed or awaiting merge",
  );
  ensure(
    p.pr_url === undefined || isHttpUrl(p.pr_url),
    "validation_failed",
    "pr_url must be an absolute HTTP or HTTPS URL",
  );
  text(p.summary, "summary");
  ensure(
    [...p.summary].length <= 160,
    "validation_failed",
    "summary exceeds 160 code points",
  );
  ensure(
    [
      "code",
      "design",
      "doc",
      "test_report",
      "card_completion",
      "other",
    ].includes(p.kind),
    "validation_failed",
    "Unknown delivery kind",
  );
  ensure(
    p.subject &&
      ["git_head", "artifact_sha256", "doc_version"].includes(p.subject.kind),
    "validation_failed",
    "subject is required",
  );
  text(p.subject.value, "subject.value");
  ensure(
    p.subject.kind === "doc_version" ||
      (p.subject.kind === "git_head"
        ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu
        : /^[a-f0-9]{64}$/iu
      ).test(p.subject.value),
    "validation_failed",
    "Invalid subject digest",
  );
  const completion = p.kind === "card_completion";
  if (completion) requireCardDependencies(d, card);
  // C-202: the completion's plain change note becomes the merge
  // confirmation's (or human completion review's) plain summary.
  ensure(
    completion || flowAtLeast(card, 5) || p.plain_summary === undefined,
    "validation_failed",
    "人话改动说明（plain_summary）只在完成申请（card_completion）里填写",
  );
  ensure(
    !completion || !flowAtLeast(card, 5) || system,
    "unauthorized",
    "本卡由系统汇总完成申请，作者只需提交产出交付",
  );
  if (completion || p.plain_summary !== undefined)
    buildPlainSummary(
      p.plain_summary,
      completion
        ? "完成申请的人话改动说明（plain_summary）"
        : "产出交付的人话改动说明（plain_summary）",
    );
  const template = resolveCardTemplate(d, card);
  ensure(
    p.subject.kind !== "git_head" ||
      (template.merge !== "none" && card.repo && card.base_branch),
    "validation_failed",
    "该模板或无仓库卡片不能提交 Git 交付",
  );
  if (
    flowAtLeast(card, 3) &&
    d.state.project_settings?.merge_gate_enabled &&
    p.subject.kind === "git_head"
  )
    ensure(
      d.state.events.some((event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          return false;
        const check = payload as Record<string, unknown>;
        return (
          event.card_id === card.id &&
          event.actor.kind === "system" &&
          event.actor.project_id === d.state.project_id &&
          event.type === "precheck_finished" &&
          check.head_sha === p.subject.value &&
          check.status === "passed"
        );
      }),
      "illegal_transition",
      "请先 request_check",
    );
  ensure(
    !completion || template.completion.mode === "review",
    "illegal_transition",
    "该模板不使用完成申请",
  );
  // §4.4 (user ruling): a produce work item that no verification points at is
  // done when it is delivered, so it requests no verifiers at all. Everything
  // else keeps the "explicit distinct verifiers" rule.
  const verifying = d
    .list("work_items")
    .filter(
      (w) =>
        w.card_id === card.id &&
        w.kind === "verify" &&
        !w.replaced_by_work_item_id &&
        (completion
          ? isCompletionVerifier(template, w)
          : w.target_work_item_id === item.id),
    );
  ensure(
    Array.isArray(p.requested_verifiers) &&
      new Set(p.requested_verifiers).size === p.requested_verifiers.length &&
      (verifying.length > 0
        ? p.requested_verifiers.length > 0
        : p.requested_verifiers.length === 0),
    "validation_failed",
    verifying.length > 0
      ? "Explicit distinct requested_verifiers are required"
      : "A work item nothing verifies must not request verifiers",
  );
  const verifiers = p.requested_verifiers.map((id) => d.work(id));
  const invalid = verifiers.filter(
    (w) =>
      !(
        w.card_id === card.id &&
        w.kind === "verify" &&
        !w.replaced_by_work_item_id &&
        (completion
          ? isCompletionVerifier(template, w)
          : w.target_work_item_id === item.id)
      ),
  );
  ensure(
    invalid.length === 0,
    "invariant_violation",
    `Verifiers must verify this delivery: ${invalid.map((w) => w.id).join(", ")}`,
  );
  const required = verifying.filter((w) => w.required);
  const missing = required.filter((w) => !p.requested_verifiers.includes(w.id));
  ensure(
    verifying.length === 0 || (required.length > 0 && missing.length === 0),
    "invariant_violation",
    `All required verifiers must be requested: ${missing.map((w) => w.id).join(", ")}`,
  );
  if (completion)
    ensure(
      card.template === template.id &&
        item.template_key === template.primary_work_item_key,
      "unauthorized",
      "Only the primary producer can request completion",
    );
  if (completion)
    ensure(
      !missingIndependentReview(d, card),
      "invariant_violation",
      "高危交付须添加同卡、指向该产出项的必需 independent_reviewer 独立复核验证项",
    );
  if (
    !completion &&
    card.template === "integration" &&
    card.template_version === 1
  )
    ensure(
      p.subject.kind === "git_head" &&
        hasProbeEvidence(
          d.state.events,
          {
            project_id: d.state.project_id,
            card_id: card.id,
            work_item_id: item.id,
          },
          p.subject.value,
          p.attachments ?? [],
        ),
      "invariant_violation",
      "集成交付需要当前任务与版本的真实冒烟附件，且清理已完成",
    );
  for (const attachment of p.attachments ?? [])
    ensure(
      d.get("attachments", attachment).card_id === card.id,
      "validation_failed",
      "Attachment belongs to another card",
    );
  return {
    item,
    card,
    verifiers,
    run: system
      ? d.get(
          "runs",
          d
            .list("deliveries")
            .find(
              (v) =>
                v.work_item_id === item.id &&
                v.kind !== "card_completion" &&
                v.status !== "superseded",
            )?.run_id ?? "",
        )
      : d.currentRun(),
    completion,
    // Nothing points a verification at this produce item.
    unreviewed: !completion && verifying.length === 0,
  };
}

const proof = Symbol("verified-delivery");
export interface VerifiedDelivery {
  readonly [proof]: true;
  readonly binding: string;
  readonly evidence: readonly DeliveryEvidence[];
  readonly test_review?: TestReviewProof;
}
function binding(d: CommandDraft, subject: DeliverySubject): string {
  const a = d.assignment;
  return JSON.stringify([
    d.state.project_id,
    a?.id,
    a?.role_version,
    a?.machine_id,
    a?.branch,
    a?.base_sha,
    a?.worktree_path,
    d.currentRun().id,
    subject.kind,
    subject.value,
  ]);
}
// Adapter preflight: invoke the injected verifier before entering the synchronous transaction.
// submitDelivery rechecks state/authorization and allocates IDs only inside that transaction.
export async function prepareDelivery(
  state: CommandState,
  actor: Actor,
  params: SubmitDeliveryParams,
  verifier: DeliveryVerifier,
): Promise<Result<VerifiedDelivery>> {
  const checked = attempt(() => {
    const d = new CommandDraft(state, actor, "submit_delivery");
    inspect(d, params);
    return d;
  });
  if (!checked.ok) return checked;
  const d = checked.value;
  const a = d.assignment as Assignment;
  const expected = binding(d, params.subject);
  try {
    const result = await verifier.verify(
      { ...params.subject },
      { ...a, runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null },
      params.kind === "card_completion"
        ? undefined
        : d
            .list("deliveries")
            .filter(
              (v) =>
                v.work_item_id === params.work_item_id &&
                v.kind !== "card_completion" &&
                v.status !== "superseded",
            )
            .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0],
    );
    let testReview: TestReviewProof | undefined;
    if (
      result.ok &&
      params.kind !== "card_completion" &&
      params.subject.kind === "git_head"
    ) {
      const previous = d
        .list("deliveries")
        .find(
          (v) =>
            v.work_item_id === params.work_item_id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        );
      for (const id of params.requested_verifiers) {
        const candidate = testReviewCandidate(
          d,
          previous,
          d.work(id),
          params.subject.value,
        );
        if (!candidate) continue;
        try {
          testReview = await state.test_review_trust?.prepare(candidate);
        } catch {
          /* Full review. */
        }
        break;
      }
    }
    return result.ok
      ? {
          ok: true,
          value: {
            [proof]: true,
            binding: expected,
            evidence: result.value,
            ...(testReview ? { test_review: testReview } : {}),
          },
        }
      : result;
  } catch {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Delivery verification failed",
      },
    };
  }
}

function readyVerifier(d: CommandDraft, item: WorkItem): WorkItem {
  if (
    item.status === "ready" ||
    (item.status === "waiting_decision" &&
      (pendingReviewLimit(d, item) ||
        item.role_id === "independent_reviewer" ||
        flowAtLeast(d.card(item.card_id), 5)))
  )
    return item;
  return d.move(
    item,
    item.status === "todo" ? "target_delivered" : "target_redelivered",
  );
}
export function submitDelivery(
  state: CommandState,
  actor: Actor,
  params: SubmitDeliveryParams,
  verified: VerifiedDelivery,
  ports: CommandPorts,
) {
  const result = command(
    state,
    actor,
    "submit_delivery",
    ports,
    deliverySubmission(params, verified),
  );
  if (!result.ok) return result;
  // Ready-verifier rules may invalidate this very completion in the same
  // transaction. Return its final state, as persisted, to the caller too.
  const final = result.value.changes.find(
    (c) =>
      c.collection === "deliveries" && c.entity.id === result.value.data.id,
  );
  return final?.collection === "deliveries"
    ? { ...result, value: { ...result.value, data: final.entity } }
    : result;
}

/** Internal composition: request_recheck settles both streams in one transaction. */
export function deliverySubmission(
  params: SubmitDeliveryParams,
  verified: VerifiedDelivery,
  recheck?: { previous: Delivery },
): (d: CommandDraft) => Delivery {
  return (d) => {
    let p = params;
    let { item, card, verifiers, run, completion, unreviewed } = inspect(d, p);
    const system =
      d.actor.kind === "system" && d.tool === "system_complete_card";
    const conflictEvent = conflictRepairEvent(d, item, run, completion);
    ensure(
      verified?.[proof] &&
        (system || verified.binding === binding(d, p.subject)),
      "stale_target",
      "Verification must match this assignment, run and subject",
    );
    const added = upgradeFastPatch(d, {
      ...p,
      evidence: verified.evidence,
    });
    if (added.length) {
      p = {
        ...p,
        requested_verifiers: [...new Set([...p.requested_verifiers, ...added])],
      };
      ({ item, card, verifiers, run, completion, unreviewed } = inspect(d, p));
    }
    const previous = d
      .list("deliveries")
      .filter(
        (v) =>
          v.work_item_id === item.id &&
          v.status !== "superseded" &&
          (!completion || v.kind === "card_completion"),
      );
    const predecessors = previous.filter(
      (v) => (v.kind === "card_completion") === completion,
    );
    ensure(
      !p.supersedes || predecessors.some((v) => v.id === p.supersedes),
      "stale_target",
      "supersedes must be a current delivery in the same stream",
    );
    const predecessor =
      recheck?.previous ??
      predecessors.find((v) => v.id === p.supersedes) ??
      predecessors[0];
    const preparedTest = verified.test_review;
    const expectedTest =
      preparedTest && p.subject.kind === "git_head" && !completion
        ? testReviewCandidate(
            d,
            predecessor,
            d.work(preparedTest.verifier_id),
            p.subject.value,
          )
        : undefined;
    const matchingTest =
      expectedTest &&
      preparedTest &&
      Object.entries(expectedTest).every(
        ([key, value]) => preparedTest[key as keyof TestReviewProof] === value,
      )
        ? preparedTest
        : undefined;
    // Superseded confirmations cannot block their replacement's preconditions.
    // A later rejection discards this entire draft, including the invalidation.
    for (const old of previous) supersedeDelivery(d, card, old);
    const checks: { key: string; passed: boolean }[] = [];
    if (completion) {
      const product = d
        .list("deliveries")
        .find(
          (v) =>
            v.work_item_id === item.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        );
      ensure(
        product && sameSubject(product.subject, p.subject),
        "stale_target",
        "Completion must bind to the current product delivery",
      );
      const cardWorkIds = new Set(
        d
          .list("work_items")
          .filter((w) => w.card_id === card.id)
          .map((w) => w.id),
      );
      ensure(
        !invalidTestReviewPasses(
          d.state,
          d
            .list("deliveries")
            .filter(
              (v) =>
                v.status !== "superseded" && cardWorkIds.has(v.work_item_id),
            ),
        ).length,
        "stale_target",
        "增量复核的隔离证据已失效，请重新交付并完整复核",
        { completion_precondition: true },
      );
      checks.push(
        ...d
          .list("work_items")
          .filter(
            (w) =>
              w.card_id === card.id &&
              w.required &&
              !p.requested_verifiers.includes(w.id),
          )
          .map((w) => ({
            key: `work_item:${w.id}`,
            passed:
              workCompleted(w) &&
              !d.list("deliveries").some(
                (v) =>
                  v.status !== "superseded" &&
                  v.kind !== "card_completion" &&
                  (v.work_item_id === w.id ||
                    v.requested_verifiers.includes(w.id)) &&
                  v.reused_reviews?.some((id) => {
                    const r = d.get("reviews", id);
                    return (
                      (w.kind === "produce" || r.work_item_id === w.id) &&
                      isReviewStale(r, v)
                    );
                  }),
              ),
          })),
      );
      checks.push(
        ...d
          .list("decisions")
          .filter(
            (q) =>
              q.blocking &&
              ["open", "snoozed"].includes(q.status) &&
              (q.card_id === card.id ||
                q.affected_cards.includes(card.id) ||
                q.affected_work_items.some(
                  (id) => d.get("work_items", id).card_id === card.id,
                )),
          )
          .map((q) => ({ key: `decision:${q.id}`, passed: false })),
      );
      // A human-reviewed template has no completion verifier in between, so
      // its required verifications (e.g. design_review) cannot be waived as
      // known gaps: the human must only see work that passed them.
      const { completion: rule } = resolveCardTemplate(d, card);
      const humanReviewed = rule.mode === "review" && rule.reviewer === "human";
      if (humanReviewed) {
        // Non-waivable verification failures take priority over ordinary gaps,
        // regardless of the order in which work items were loaded or updated.
        const unmetVerification = d
          .list("work_items")
          .find(
            (w) =>
              w.kind === "verify" &&
              checks.some((c) => c.key === `work_item:${w.id}` && !c.passed),
          );
        ensure(
          !unmetVerification,
          "invariant_violation",
          `人验收的完成申请须等必需验证项通过后再提交：${unmetVerification?.id}`,
          { completion_precondition: true },
        );
      }
      for (const check of checks.filter((c) => !c.passed)) {
        const gap = p.known_gaps?.find((g) => g.precondition === check.key);
        ensure(
          gap?.description.trim() &&
            gap.followup_card_id &&
            gap.followup_card_id !== card.id &&
            d.get("cards", gap.followup_card_id).project_id ===
              d.state.project_id,
          "invariant_violation",
          `Known gap with follow-up card required: ${check.key}`,
          { completion_precondition: true },
        );
      }
    }
    for (const decision of d.list("decisions")) {
      if (
        decision.trigger === "completion_review" &&
        decision.kind === "approve" &&
        "delivery_id" in decision.target &&
        ["open", "provisional", "snoozed"].includes(decision.status)
      ) {
        const targetId = decision.target.delivery_id;
        if (previous.some((old) => old.id === targetId))
          d.put("decisions", {
            ...decision,
            status: unwrap(
              transition("decision", decision.status, "supersede"),
            ),
          });
      }
    }
    // A new product withdraws the old completion target until a new request arrives.
    for (const old of previous.filter((v) => v.kind === "card_completion"))
      for (const id of old.requested_verifiers) {
        if (
          !d.work(id).target_work_item_id &&
          !p.requested_verifiers.includes(id)
        )
          d.put("work_items", d.move(d.work(id), "target_withdrawn"));
      }
    if (!completion)
      d.put("work_items", d.move(activeWork(d, item), "delivery_submitted"));
    let candidate: Delivery = {
      id: d.ids.next(d.state.project_id, "delivery"),
      work_item_id: item.id,
      run_id: run.id,
      kind: p.kind,
      summary: p.summary,
      subject: { ...p.subject },
      // Accepted on arrival when nothing verifies the work item (§4.4).
      status: unreviewed ? "accepted" : "submitted",
      requested_verifiers: [...p.requested_verifiers],
      ...(conflictEvent ? { merge_conflict_event_id: conflictEvent } : {}),
      attachments: [...(p.attachments ?? [])],
      known_gaps: [...(p.known_gaps ?? [])],
      evidence: [
        ...verified.evidence,
        ...(completion
          ? [
              {
                kind: "test" as const,
                details: { completion_preconditions: checks },
              },
            ]
          : []),
      ],
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.pr_url ? { pr_url: p.pr_url } : {}),
      ...(p.test_results ? { test_results: p.test_results } : {}),
      ...(p.plain_summary !== undefined
        ? {
            plain_summary: buildPlainSummary(
              p.plain_summary,
              completion
                ? "完成申请的人话改动说明（plain_summary）"
                : "产出交付的人话改动说明（plain_summary）",
            ),
          }
        : {}),
      ...(predecessor ? { supersedes: predecessor.id } : {}),
      ...(recheck ? { recheck_of: recheck.previous.id } : {}),
    };
    if (matchingTest) {
      const withProof: Delivery = {
        ...candidate,
        test_review: { ...matchingTest, delivery_id: candidate.id },
      };
      if (incrementalTestReview(d, d.work(matchingTest.verifier_id), withProof))
        candidate = withProof;
    }
    const reused = system ? [] : reusableReviews(d, predecessor, candidate);
    const reusedItems = new Set(reused.map((r) => r.work_item_id));
    const allReused =
      verifiers.length > 0 && verifiers.every((w) => reusedItems.has(w.id));
    const value: Delivery = {
      ...candidate,
      ...(reused.length ? { reused_reviews: reused.map((r) => r.id) } : {}),
      ...(allReused ? { status: "accepted" } : {}),
    };
    for (const verifier of verifiers)
      if (!reusedItems.has(verifier.id))
        d.put("work_items", readyVerifier(d, verifier));
    d.put("deliveries", value);
    if (unreviewed || (!completion && allReused)) {
      // Keep a target reviewable while any newly requested verifier still needs to act.
      d.put("work_items", d.move(d.work(item.id), "verifiers_passed"));
      d.emit(
        "delivery_accepted",
        card.id,
        {
          delivery_id: value.id,
          work_item_id: item.id,
          ...(unreviewed
            ? { unreviewed: true }
            : { reused_reviews: reused.map((r) => r.id) }),
        },
        {
          type: "system",
          body: unreviewed
            ? "没有验证项指向这个工作项，交付直接接受，无需审核。"
            : "请求的验证项已全部沿用有效通过结论，交付接受。",
          delivery_id: value.id,
          work_item_id: item.id,
          run_id: run.id,
        },
      );
    }
    const status = completion
      ? unwrap(transition("card", card.status, "completion_submitted"))
      : deriveCardStatus(
          card.status,
          d.list("work_items").filter((w) => w.card_id === card.id),
        );
    d.put("cards", { ...card, status });
    d.emit(
      "delivery_submitted",
      card.id,
      { delivery_id: value.id, superseded: previous.map((v) => v.id) },
      {
        type: "delivery",
        body: p.summary,
        delivery_id: value.id,
        work_item_id: item.id,
        run_id: run.id,
      },
    );
    if (!completion) applyDeliveryAutoRiskTags(d, value.id);
    for (const review of reused) {
      d.emit(
        "review_reused",
        card.id,
        {
          review_id: review.id,
          source_delivery_id: review.delivery_id,
          delivery_id: value.id,
          work_item_id: review.work_item_id,
          target_sha: value.subject.value,
          tree_sha: deliveryTree(value) ?? null,
        },
        {
          type: "system",
          author: "system",
          delivery_id: value.id,
          work_item_id: review.work_item_id,
          body: `${value.id} 沿用自 ${review.id}（代码等价，原交付 ${review.delivery_id}）；保留原审核作者和时间。`,
          refs: [
            { kind: "review", id: review.id },
            { kind: "delivery", id: review.delivery_id },
          ],
        },
      );
      if (predecessor)
        reuseIndependentReviewCheck(d, review, predecessor, value);
    }
    if (completion) requestHumanCompletionReview(d, card, value);
    const completionRule = resolveCardTemplate(d, card);
    const withoutCompletionReviewer =
      system &&
      !verifiers.length &&
      completionRule.completion.mode === "review" &&
      completionRule.completion.reviewer !== "human" &&
      !completionRule.work_items.some(
        (w) => w.kind === "verify" && !w.target_work_item_key,
      );
    if (completion && (allReused || withoutCompletionReviewer)) {
      d.put("deliveries", { ...value, status: "accepted" });
      completionPassed(d, d.card(card.id), value);
    }
    for (const verifier of verifiers) {
      if (reusedItems.has(verifier.id)) continue;
      const current = d.work(verifier.id);
      if (
        current.kind === "verify" &&
        (reviewRound(d, current) > current.max_review_rounds ||
          current.status === "waiting_decision" ||
          reviewRejectionsNeedAttention(d, current))
      )
        requestReviewLimit(d, current);
    }
    return value;
  };
}

/** Internal rule: reuse the already verified current product; no new Git IO. */
export function systemCompletionSubmission(
  d: CommandDraft,
  p: SubmitDeliveryParams,
  product: Delivery,
): Delivery {
  ensure(
    d.actor.kind === "system" && d.tool === "system_complete_card",
    "unauthorized",
    "Only the completion rule can aggregate deliveries",
  );
  return deliverySubmission(p, {
    [proof]: true,
    binding: "system",
    evidence: product.evidence,
  })(d);
}

export type SubmitReviewParams = Pick<
  Review,
  "delivery_id" | "target_sha" | "kind" | "issues"
> &
  Partial<
    Pick<
      Review,
      | "attachments"
      | "recheck_required"
      | "screenshot_check"
      | "followup_card_id"
    >
  >;
export function submitReview(
  state: CommandState,
  actor: Actor,
  p: SubmitReviewParams,
  ports: CommandPorts,
) {
  return command(state, actor, "submit_review", ports, (d) => {
    const target = d.get("deliveries", p.delivery_id);
    const producer = d.work(target.work_item_id);
    const card = d.card(producer.card_id);
    ensure(
      systemCompletionCurrent(d, card, target),
      "stale_target",
      "系统完成申请的产出或审核依据已失效",
    );
    const cardOpen = !["done", "cancelled", "awaiting_merge"].includes(
      card.status,
    );
    // Preserve old error precedence; flow 5 reports an obsolete review target
    // even when its replacement has already reached the merge gate.
    if (!flowAtLeast(card, 5))
      ensure(
        cardOpen,
        "illegal_transition",
        "Card is closed or awaiting merge",
      );
    ensure(
      d.assignment?.scope === "work_item",
      "unauthorized",
      "A verification assignment is required",
    );
    let item = d.ownWork(d.assignment.work_item_id);
    checkEmployeeSeparation(d, item, d.assignment.employee_id, target);
    ensure(
      item.kind === "verify" &&
        item.card_id === card.id &&
        !item.replaced_by_work_item_id &&
        target.requested_verifiers.includes(item.id) &&
        (target.kind === "card_completion"
          ? isCompletionVerifier(resolveCardTemplate(d, card), item)
          : item.target_work_item_id === producer.id),
      "unauthorized",
      "Assignment is not a verifier for this delivery",
    );
    ensure(
      !isReviewStale(
        { delivery_id: p.delivery_id, target_sha: p.target_sha },
        target,
      ),
      "stale_target",
      "Review target is obsolete",
    );
    const parallelLate =
      flowAtLeast(card, 5) &&
      target.kind !== "card_completion" &&
      target.status === "rejected";
    if (parallelLate) {
      ensure(
        !d
          .list("deliveries")
          .some(
            (v) =>
              v.work_item_id === producer.id &&
              v.kind !== "card_completion" &&
              Number(v.id.slice(2)) > Number(target.id.slice(2)),
          ),
        "stale_target",
        "Review target is obsolete",
      );
      ensure(
        !d
          .list("reviews")
          .some(
            (r) => r.delivery_id === target.id && r.work_item_id === item.id,
          ),
        "illegal_transition",
        "Verifier has already reviewed this delivery",
      );
    }
    ensure(cardOpen, "illegal_transition", "Card is closed or awaiting merge");
    ensure(
      target.status === "submitted" || parallelLate,
      "illegal_transition",
      "Delivery has already been reviewed",
    );
    ensure(
      ["code", "design", "test", "replay", "product", "user"].includes(p.kind),
      "validation_failed",
      "Invalid review kind",
    );
    ensure(
      Array.isArray(p.issues) &&
        p.issues.every(
          (i) =>
            i &&
            ["critical", "major", "minor"].includes(i.severity) &&
            typeof i.must_fix === "boolean" &&
            typeof i.pre_existing === "boolean" &&
            typeof i.description === "string" &&
            i.description.trim() &&
            (i.proof === undefined || typeof i.proof === "string"),
        ),
      "validation_failed",
      "Review issues must describe severity and must_fix",
    );
    ensure(
      p.issues.every((i) =>
        i.impact === undefined
          ? !i.must_fix
          : REVIEW_IMPACTS.includes(i.impact),
      ),
      "validation_failed",
      "Every must-fix issue requires a valid impact",
    );
    const calculated = deriveReview(
      p.issues,
      p.recheck_required ?? false,
      p.followup_card_id,
    );
    if (p.followup_card_id !== undefined) {
      ensure(
        calculated.verdict === "conditional" &&
          !p.recheck_required &&
          !!p.followup_card_id,
        "validation_failed",
        "Only UX-only must-fix issues can be deferred to a follow-up card",
      );
      const followup = d.get("cards", p.followup_card_id);
      ensure(
        followup.id !== card.id &&
          followup.project_id === card.project_id &&
          !["done", "cancelled"].includes(followup.status),
        "validation_failed",
        "Follow-up must be a different open card in the same project",
      );
    }
    ensure(
      p.screenshot_check === undefined ||
        p.screenshot_check === "passed" ||
        p.screenshot_check === "failed",
      "validation_failed",
      "screenshot_check must be passed or failed",
    );
    ensure(
      p.screenshot_check === undefined ||
        d.assignment.role_id === "independent_reviewer",
      "forbidden_tool",
      "只有独立复核员可以在审核里给出截图核对结论",
    );
    for (const id of p.attachments ?? [])
      ensure(
        d.get("attachments", id).card_id === card.id,
        "validation_failed",
        "Attachment belongs to another card",
      );
    const run = d.currentRun();
    ensure(
      !d.list("reviews").some((r) => r.run_id === run.id),
      "invariant_violation",
      "A Run may submit only one review",
    );
    const testReview = incrementalTestReview(d, item, target);
    ensure(
      !run.test_review ||
        (testReview &&
          JSON.stringify(run.test_review) === JSON.stringify(testReview)),
      "stale_target",
      "Incremental review scope expired; start a full review Run",
    );
    ensure(
      !testReview || run.test_review,
      "stale_target",
      "Incremental review requires a host-bound Run scope",
    );
    const round = reviewRound(d, item, target);
    ensure(
      round <= item.max_review_rounds,
      "illegal_transition",
      "Review round limit has been reached",
    );
    const prior = d
      .list("reviews")
      .filter((r) => r.work_item_id === item.id)
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    if (prior && !testReview)
      ensure(
        p.issues.every(
          (issue) =>
            issue.pre_existing ||
            prior.issues.some(
              (old) => old.description.trim() === issue.description.trim(),
            ) ||
            ((issue.severity === "critical" ||
              (issue.severity === "major" && issue.must_fix)) &&
              issue.proof?.trim()),
        ),
        "validation_failed",
        "New findings after round one require critical severity or a must-fix major issue, with proof (reproduction steps, script or attachment reference)",
      );
    item = activeWork(d, item);
    ensure(
      item.status === "in_progress",
      "illegal_transition",
      "Verification is not running or its round limit was reached",
    );

    const reuseContext = deliveryTree(target)
      ? reviewReuseContext(d, target, item, d.assignment.id)
      : undefined;
    const value: Review = {
      id: d.ids.next(state.project_id, "review"),
      delivery_id: target.id,
      target_sha: p.target_sha,
      work_item_id: item.id,
      run_id: run.id,
      kind: p.kind,
      ...calculated,
      ...(p.followup_card_id ? { followup_card_id: p.followup_card_id } : {}),
      recheck_required: p.recheck_required ?? false,
      ...(testReview ? { test_review: testReview } : {}),
      attachments: [...(p.attachments ?? [])],
      ...(reuseContext
        ? {
            reuse_basis: {
              context: reuseContext,
              assignment_id: d.assignment.id,
            },
          }
        : {}),
      ...(p.screenshot_check === undefined
        ? {}
        : { screenshot_check: p.screenshot_check }),
    };
    d.put("reviews", value);
    if (reviewPassed(value) || value.blocking)
      item = d.move(
        item,
        reviewPassed(value) ? "review_passed" : "review_rejected",
      );
    d.put("work_items", item);
    const required = target.requested_verifiers.filter(
      (id) => d.work(id).required,
    );
    const allPassed = required.every((id) =>
      reviewPassed(
        d
          .list("reviews")
          .filter((r) => r.work_item_id === id && !isReviewStale(r, target))
          .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0],
      ),
    );
    if (!parallelLate && (value.blocking || allPassed)) {
      d.put("deliveries", {
        ...target,
        status: unwrap(
          transition(
            "delivery",
            target.status,
            value.blocking ? "reject" : "accept",
          ),
        ),
      });
      if (target.kind === "card_completion" && value.blocking)
        d.put("cards", {
          ...card,
          status: unwrap(
            transition(
              "card",
              card.status,
              value.blocking
                ? "completion_review_rejected"
                : "completion_review_passed",
            ),
          ),
        });
      else if (target.kind !== "card_completion")
        d.put(
          "work_items",
          d.move(
            producer,
            value.blocking ? "review_rejected" : "verifiers_passed",
          ),
        );
    }
    const limitReached =
      value.verdict === "reject" &&
      (round >=
        (item.kind === "verify"
          ? item.max_review_rounds
          : reviewMaxRounds(projectPreferences(d.state))) ||
        reviewRejectionsNeedAttention(d, item));
    const flowLimit = limitReached;
    const flowRaised = flowLimit
      ? requestReviewLimit(d, d.work(item.id))
      : false;
    d.emit(
      "review_submitted",
      card.id,
      {
        review_id: value.id,
        delivery_id: target.id,
        verdict: value.verdict,
        recheck_required: value.recheck_required,
        ...(value.followup_card_id
          ? { followup_card_id: value.followup_card_id }
          : {}),
        issues: value.issues.map((issue) => ({ ...issue })),
        rework_allowed:
          (value.blocking || value.recheck_required) &&
          (!limitReached || flowRaised === true),
        ...(flowLimit && !flowRaised ? { review_limit_wait: true } : {}),
        ...(parallelLate ? { parallel_late: true } : {}),
      },
      {
        type: "review",
        body: testReview
          ? `增量复核（只改测试）：${value.verdict}`
          : value.verdict,
        delivery_id: target.id,
        work_item_id: item.id,
        run_id: run.id,
      },
    );
    if (d.assignment.role_id === "independent_reviewer") {
      projectIndependentReviewCheck(d, value);
      projectScreenshotCheck(d, value);
    }
    if (target.kind === "card_completion" && allPassed && !value.blocking)
      completionPassed(d, d.card(card.id), target);
    if (limitReached && !flowLimit) requestReviewLimit(d, item);
    return value;
  });
}
