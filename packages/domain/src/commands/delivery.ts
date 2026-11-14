import {
  currentDeliveryPrechecks,
  requiresDeliveryPrecheck,
  verificationPrecheckPending,
} from "../delivery-precheck.js";
import { deriveCardStatus, deriveReview, isReviewStale } from "../derived.js";
import type {
  Actor,
  Assignment,
  Delivery,
  DeliveryEvidence,
  DeliverySubject,
  Review,
  WorkItem,
} from "../entities.js";
import type { Result } from "../errors.js";
import type { DeliveryVerifier } from "../ports.js";
import { reviewMaxRounds } from "../preferences.js";
import { isCompletionVerifier } from "../templates.js";
import { transition } from "../transitions.js";
import { isHttpUrl } from "../url.js";
import {
  attempt,
  CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { supersedeDelivery } from "./delivery-invalidation.js";
import { queueDeliveryPrecheck } from "./delivery-precheck.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { requestHumanCompletionReview } from "./human-completion.js";
import { completionPassed } from "./merge.js";
import { buildPlainSummary } from "./plain-summary.js";
import {
  projectIndependentReviewCheck,
  projectScreenshotCheck,
} from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import { pendingReviewLimit, requestReviewLimit } from "./review-limit.js";
import { conflictRepairEvent } from "./review-round.js";
import { resolveCardTemplate } from "./templates.js";
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
  const item = d.ownWork(p.work_item_id);
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
  if (completion)
    ensure(
      currentDeliveryPrechecks(d.state, card.id).every(
        (c) => c.status === "passed",
      ),
      "illegal_transition",
      "当前产出交付的预检查尚未通过，请先完成预检查",
    );
  // C-202: the completion's plain change note becomes the merge
  // confirmation's (or human completion review's) plain summary.
  ensure(
    completion || p.plain_summary === undefined,
    "validation_failed",
    "人话改动说明（plain_summary）只在完成申请（card_completion）里填写",
  );
  if (completion)
    buildPlainSummary(
      p.plain_summary,
      "完成申请的人话改动说明（plain_summary）",
    );
  const template = resolveCardTemplate(d, card);
  ensure(
    p.subject.kind !== "git_head" ||
      (template.merge !== "none" && card.repo && card.base_branch),
    "validation_failed",
    "该模板或无仓库卡片不能提交 Git 交付",
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
  if (
    completion &&
    card.risk_tags?.length &&
    template.completion.mode === "review" &&
    template.completion.reviewer !== "human"
  )
    ensure(
      d
        .list("work_items")
        .some(
          (w) =>
            w.card_id === card.id &&
            w.kind === "verify" &&
            w.role_id === "independent_reviewer" &&
            w.required &&
            w.status !== "cancelled" &&
            !w.replaced_by_work_item_id,
        ),
      "invariant_violation",
      "卡片已设置风险标签，提交完成申请前须添加必需且未取消的 independent_reviewer 独立复核验证项",
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
    run: d.currentRun(),
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
    );
    return result.ok
      ? {
          ok: true,
          value: { [proof]: true, binding: expected, evidence: result.value },
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
    (item.status === "waiting_decision" && pendingReviewLimit(d, item))
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
  return command(state, actor, "submit_delivery", ports, (d) => {
    const p = params;
    const { item, card, verifiers, run, completion, unreviewed } = inspect(
      d,
      p,
    );
    const conflictEvent = conflictRepairEvent(d, item, run, completion);
    ensure(
      verified?.[proof] && verified.binding === binding(d, p.subject),
      "stale_target",
      "Verification must match this assignment, run and subject",
    );
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
      predecessors.find((v) => v.id === p.supersedes) ?? predecessors[0];
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
      checks.push(
        ...d
          .list("work_items")
          .filter(
            (w) =>
              w.card_id === card.id &&
              w.required &&
              !p.requested_verifiers.includes(w.id),
          )
          .map((w) => ({ key: `work_item:${w.id}`, passed: workCompleted(w) })),
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
      for (const check of checks.filter((c) => !c.passed)) {
        const waivable =
          !humanReviewed ||
          !d
            .list("work_items")
            .some(
              (w) => `work_item:${w.id}` === check.key && w.kind === "verify",
            );
        ensure(
          waivable,
          "invariant_violation",
          `人验收的完成申请须等必需验证项通过后再提交：${check.key.slice("work_item:".length)}`,
        );
        const gap = p.known_gaps?.find((g) => g.precondition === check.key);
        ensure(
          gap?.description.trim() &&
            gap.followup_card_id &&
            gap.followup_card_id !== card.id &&
            d.get("cards", gap.followup_card_id).project_id ===
              state.project_id,
          "invariant_violation",
          `Known gap with follow-up card required: ${check.key}`,
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
    for (const verifier of verifiers)
      d.put("work_items", readyVerifier(d, verifier));
    // A new product withdraws the old completion target until a new request arrives.
    for (const old of previous.filter((v) => v.kind === "card_completion"))
      for (const id of old.requested_verifiers) {
        if (!p.requested_verifiers.includes(id))
          d.put("work_items", d.move(d.work(id), "target_withdrawn"));
      }
    if (!completion)
      d.put("work_items", d.move(activeWork(d, item), "delivery_submitted"));
    const value: Delivery = {
      id: d.ids.next(state.project_id, "delivery"),
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
      ...(completion
        ? {
            plain_summary: buildPlainSummary(
              p.plain_summary,
              "完成申请的人话改动说明（plain_summary）",
            ),
          }
        : {}),
      ...(predecessor ? { supersedes: predecessor.id } : {}),
    };
    d.put("deliveries", value);
    if (
      !completion &&
      requiresDeliveryPrecheck(
        { ...state, work_items: d.list("work_items") },
        value,
      )
    )
      queueDeliveryPrecheck(d, value, "risk_delivery");
    if (unreviewed) {
      // §4.4: nothing verifies this work item, so the delivery is accepted on
      // arrival and the item is done; the timeline says why no review follows.
      d.put("work_items", d.move(d.work(item.id), "verifiers_passed"));
      d.emit(
        "delivery_accepted",
        card.id,
        { delivery_id: value.id, work_item_id: item.id, unreviewed: true },
        {
          type: "system",
          body: "没有验证项指向这个工作项，交付直接接受，无需审核。",
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
    if (completion) requestHumanCompletionReview(d, card, value);
    for (const verifier of verifiers) {
      const current = d.work(verifier.id);
      if (
        current.kind === "verify" &&
        !verificationPrecheckPending(
          { ...state, deliveries: d.list("deliveries") },
          current,
        ) &&
        reviewRound(d, current) > current.max_review_rounds
      )
        requestReviewLimit(d, current);
    }
    return value;
  });
}

export type SubmitReviewParams = Pick<
  Review,
  "delivery_id" | "target_sha" | "kind" | "issues"
> &
  Partial<
    Pick<Review, "attachments" | "recheck_required" | "screenshot_check">
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
      !["done", "cancelled", "awaiting_merge"].includes(card.status),
      "illegal_transition",
      "Card is closed or awaiting merge",
    );
    ensure(
      d.assignment?.scope === "work_item",
      "unauthorized",
      "A verification assignment is required",
    );
    let item = d.ownWork(d.assignment.work_item_id);
    checkEmployeeSeparation(d, item, d.assignment.employee_id);
    ensure(
      item.kind === "verify" &&
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
    ensure(
      target.status === "submitted",
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
    ensure(
      !verificationPrecheckPending(state, item),
      "illegal_transition",
      "当前交付预检查尚未通过，不能提交审核",
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
    if (prior)
      ensure(
        p.issues.every(
          (issue) =>
            issue.pre_existing ||
            prior.issues.some(
              (old) => old.description.trim() === issue.description.trim(),
            ) ||
            (issue.severity === "critical" && issue.proof?.trim()),
        ),
        "validation_failed",
        "New findings after round one require critical severity and proof",
      );
    item = activeWork(d, item);
    ensure(
      item.status === "in_progress",
      "illegal_transition",
      "Verification is not running or its round limit was reached",
    );
    const calculated = deriveReview(p.issues, p.recheck_required ?? false);
    const value: Review = {
      id: d.ids.next(state.project_id, "review"),
      delivery_id: target.id,
      target_sha: p.target_sha,
      work_item_id: item.id,
      run_id: run.id,
      kind: p.kind,
      ...calculated,
      recheck_required: p.recheck_required ?? false,
      attachments: [...(p.attachments ?? [])],
      ...(p.screenshot_check === undefined
        ? {}
        : { screenshot_check: p.screenshot_check }),
    };
    d.put("reviews", value);
    if (value.verdict !== "conditional")
      item = d.move(
        item,
        value.verdict === "pass" ? "review_passed" : "review_rejected",
      );
    d.put("work_items", item);
    const required = target.requested_verifiers.filter(
      (id) => d.work(id).required,
    );
    const allPassed = required.every(
      (id) =>
        d
          .list("reviews")
          .filter((r) => r.work_item_id === id && !isReviewStale(r, target))
          .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0]
          ?.verdict === "pass",
    );
    if (value.blocking || allPassed) {
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
      value.verdict !== "pass" &&
      round >=
        (item.kind === "verify"
          ? item.max_review_rounds
          : reviewMaxRounds(projectPreferences(d.state)));
    d.emit(
      "review_submitted",
      card.id,
      {
        review_id: value.id,
        delivery_id: target.id,
        verdict: value.verdict,
        recheck_required: value.recheck_required,
        issues: value.issues.map((issue) => ({ ...issue })),
        rework_allowed:
          (value.blocking || value.verdict === "conditional") && !limitReached,
      },
      {
        type: "review",
        body: value.verdict,
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
    if (limitReached) requestReviewLimit(d, item);
    return value;
  });
}
