import { deriveCardStatus } from "../derived.js";
import type { Actor, Delivery, PlainSummary } from "../entities.js";
import { appendEvents } from "../event-index.js";
import { flowAtLeast } from "../flow.js";
import type { CardId } from "../ids.js";
import { mergeBatches } from "../merge-batch.js";
import { transition } from "../transitions.js";
import {
  completionSources,
  missingIndependentReview,
} from "./completion-binding.js";
import {
  attempt,
  CommandDraft,
  type CommandPorts,
  type CommandState,
  unwrap,
} from "./core.js";
import { systemCompletionSubmission } from "./delivery.js";
import { refreshFastPatch } from "./fast-patch.js";
import { independentReviewRechecks } from "./independent-review-recheck.js";
import { latestMergeCheck } from "./merge-check-view.js";
import { PLAIN_SUMMARY_LIMITS } from "./plain-summary.js";
import { screenshotCheckEnforced } from "./screenshot-check.js";
import {
  invalidateCompletion,
  invalidateSystemCompletions,
} from "./system-completion-invalidation.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";
import { resolveCardTemplate } from "./templates.js";

/** Host-only, retried by the existing transactional system-rule scan. */
export function systemCompleteCard(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId },
  ports: CommandPorts,
) {
  return command(state, actor, "system_complete_card", ports, (d) => {
    refreshFastPatch(d, p.card_id);
    reopenIndependentReview(d, p.card_id);
    invalidateSystemCompletions(d, p.card_id);
    return aggregateCompletion(d, p.card_id);
  });
}

/**
 * C-805: when the merge gate no longer accepts a passed independent review,
 * the review item gets its target back instead of waiting at a gate that
 * accepts no review. The target delivery returns to review, the completion
 * built on the old conclusion is revoked, and the reviewer is notified.
 */
function reopenIndependentReview(d: CommandDraft, cardId: CardId): void {
  const card = d.card(cardId);
  if (
    card.hold ||
    !flowAtLeast(card, 5) ||
    ["backlog", "todo", "done", "cancelled"].includes(card.status) ||
    appendEvents(d.state.events, d.events).some(
      (e) => e.card_id === card.id && e.type === "card_merged",
    )
  )
    return;
  const completions = d
    .list("deliveries")
    .filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        d.work(v.work_item_id).card_id === card.id,
    );
  // A merge already running or publishing finishes on its own terms.
  if (
    completions.some(
      (v) =>
        latestMergeCheck(d.state.events, card.id, v.id)?.status === "running",
    ) ||
    mergeBatches(d.state.events).some(
      (b) =>
        (b.status === "publishing" || b.check?.status === "running") &&
        !["published", "aborted", "resolved"].includes(b.status) &&
        b.members.some((m) => m.card_id === card.id),
    )
  )
    return;
  const rechecks = independentReviewRechecks(
    { work_items: d.list("work_items"), deliveries: d.list("deliveries") },
    card,
    screenshotCheckEnforced({
      project_id: d.state.project_id,
      project_preferences: d.list("project_preferences"),
    }),
  );
  if (!rechecks.length) return;
  for (const { item, producer, target } of rechecks) {
    const delivery = d.get("deliveries", target.id);
    d.put("deliveries", {
      ...delivery,
      status:
        delivery.status === "accepted"
          ? unwrap(transition("delivery", delivery.status, "require_review"))
          : delivery.status,
      requested_verifiers: delivery.requested_verifiers.includes(item.id)
        ? delivery.requested_verifiers
        : [...delivery.requested_verifiers, item.id],
    });
    const owner = d.work(producer.id);
    if (owner.status === "accepted")
      d.put("work_items", d.move(owner, "delivery_submitted"));
    d.put("work_items", d.move(d.work(item.id), "target_redelivered"));
    d.emit(
      "delivery_verifier_added",
      card.id,
      {
        delivery_id: target.id,
        target_work_item_id: producer.id,
        work_item_id: item.id,
        target_sha: target.subject.value,
        previous_status: target.status,
        reason: "independent_review_recheck",
      },
      {
        type: "system",
        author: "system",
        work_item_id: item.id,
        delivery_id: target.id,
        body: `合并前核对“独立复核”对当前版本不再有效，${item.id} 重新复核交付 ${target.id}。`,
      },
    );
  }
  for (const completion of completions)
    if (d.get("deliveries", completion.id).status !== "superseded")
      invalidateCompletion(
        d,
        d.card(card.id),
        completion,
        "independent_review_recheck",
      );
  const current = d.card(card.id);
  if (!["done", "cancelled", "awaiting_merge"].includes(current.status))
    d.put("cards", {
      ...current,
      status: deriveCardStatus(
        current.status,
        d.list("work_items").filter((w) => w.card_id === card.id),
      ),
    });
}

function aggregateCompletion(d: CommandDraft, cardId: CardId): Delivery | null {
  const card = d.card(cardId);
  if (
    card.hold ||
    !flowAtLeast(card, 5) ||
    ["backlog", "todo", "done", "cancelled", "awaiting_merge"].includes(
      card.status,
    )
  )
    return null;
  const template = resolveCardTemplate(d, card);
  if (template.completion.mode !== "review") return null;
  const items = d.list("work_items").filter((w) => w.card_id === card.id);
  if (
    template.completion.reviewer !== "human" &&
    template.work_items.some(
      (w) =>
        w.kind === "verify" &&
        !w.target_work_item_key &&
        w.required &&
        !items.some(
          (item) =>
            item.template_key === w.key &&
            !item.replaced_by_work_item_id &&
            item.status !== "cancelled",
        ),
    )
  )
    return null;
  const existing = d
    .list("deliveries")
    .find(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        items.some((w) => w.id === v.work_item_id),
    );
  if (existing) return null; // A rejection is actionable; never resubmit it in a polling loop.
  const ready = attempt(() => completionSources(d, card));
  if (!ready.ok) {
    // Unmet source requirements are normal waits; corrupt references and
    // internal authorization/validation failures must reach the host.
    if (ready.error.code !== "invariant_violation") unwrap(ready);
    const missingIndependent = missingIndependentReview(d, card);
    if (missingIndependent) {
      const products = d
        .list("deliveries")
        .filter(
          (v) =>
            v.kind !== "card_completion" &&
            v.status !== "superseded" &&
            items.some((w) => w.id === v.work_item_id),
        )
        .map((v) => v.id)
        .sort();
      const key = JSON.stringify(products);
      if (
        !appendEvents(d.state.events, d.events).some(
          (e) =>
            e.type === "system_completion_deferred" &&
            e.card_id === card.id &&
            (e.payload as Record<string, unknown>).key === key,
        )
      )
        d.emit(
          "system_completion_deferred",
          card.id,
          {
            rule: "flow-v2/B3a",
            key,
            reason: "风险卡缺少必需且有效的独立复核项，请 PM Ops 补齐",
          },
          {
            type: "system",
            body: "系统未生成完成申请：风险卡缺少必需且有效的独立复核项，请 PM Ops 补齐。",
          },
        );
    }
    return null;
  }
  const { products, reviews, verifiers, binding } = ready.value;
  const primary = products.find(
    (v) =>
      d.work(v.work_item_id).template_key === template.primary_work_item_key,
  );
  if (!primary) return null;
  const plain_summary = Object.fromEntries(
    (Object.keys(PLAIN_SUMMARY_LIMITS) as (keyof PlainSummary)[]).map((key) => {
      const values = products.map(
        (v) =>
          v.plain_summary?.[key] ?? "作者未提供此项说明，请查看产出交付详情",
      );
      const combined = [...new Set(values)].join("；");
      const limit = PLAIN_SUMMARY_LIMITS[key];
      return [
        key,
        [...combined].length <= limit
          ? combined
          : "多项产出的说明见完成申请所附来源；系统未补写或评估",
      ];
    }),
  ) as unknown as PlainSummary;
  // Use a scratch draft: a failed shared inspect/precondition must leave no writes.
  const probe = new CommandDraft(d.state, d.actor, d.tool, d.ports);
  for (const c of d.changes) probe.put(c.collection, c.entity);
  const submitted = attempt(() =>
    systemCompletionSubmission(
      probe,
      {
        work_item_id: primary.work_item_id,
        kind: "card_completion",
        summary:
          "系统已汇总当前产出交付及必需审核，来源、白话说明和已知遗留见申请详情。",
        subject: primary.subject,
        requested_verifiers: verifiers.map((w) => w.id),
        plain_summary,
        known_gaps: products.flatMap((v) => v.known_gaps),
        attachments: [...new Set(products.flatMap((v) => v.attachments))],
        ...(primary.branch ? { branch: primary.branch } : {}),
      },
      primary,
    ),
  );
  if (
    !submitted.ok &&
    submitted.error.details?.completion_precondition === true
  )
    return null;
  const delivery = unwrap(submitted);
  const result: Delivery = {
    ...probe.get("deliveries", delivery.id),
    system_completion: {
      version: 1,
      binding,
      products: products.map((v) => ({
        delivery_id: v.id,
        subject: v.subject,
        summary: v.summary,
        plain_summary: v.plain_summary ?? null,
        known_gaps: v.known_gaps,
      })),
      reviews: reviews.map((r) => {
        const reviewAuthor = `assignment:${d.get("runs", r.run_id).assignment_id}`;
        const notes = [...d.state.timeline, ...d.timeline]
          .filter(
            (t) =>
              !t.retracted &&
              t.author === reviewAuthor &&
              ((t.type === "review" &&
                t.run_id === r.run_id &&
                ![
                  "pass",
                  "conditional",
                  "reject",
                  "增量复核（只改测试）：pass",
                ].includes(t.body)) ||
                t.refs.some((ref) => ref.kind === "review" && ref.id === r.id)),
          )
          .map((t) => ({ timeline_entry_id: t.id, body: t.body }));
        return {
          review_id: r.id,
          delivery_id: r.delivery_id,
          target_sha: r.target_sha,
          work_item_id: r.work_item_id,
          kind: r.kind,
          issues: r.issues,
          ...(r.followup_card_id
            ? { followup_card_id: r.followup_card_id }
            : {}),
          attachments: r.attachments,
          acceptance_evidence: notes,
          acceptance_evidence_missing: notes.length === 0,
        };
      }),
    },
  };
  probe.put("deliveries", result);
  for (const c of probe.changes) d.put(c.collection, c.entity);
  d.events.push(...probe.events);
  d.timeline.push(...probe.timeline);
  return result;
}
