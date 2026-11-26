import { autoRiskPathEvidence } from "../auto-risk.js";
import type { Actor, Card, WorkItem } from "../entities.js";
import { appendEvents } from "../event-index.js";
import { highRiskProducts } from "../high-risk.js";
import type { DeliveryId } from "../ids.js";
import {
  autoSecurityPaths,
  displayChangedPath,
  initialReviewMaxRounds,
  mergePathMatches,
  validMergePathList,
} from "../preferences.js";
import { activeTemplateRole } from "../templates.js";
import {
  CommandDraft,
  type CommandPorts,
  type CommandState,
  ensure,
} from "./core.js";
import { bindRequiredVerifier } from "./late-verifier.js";
import { syncRiskTagMerge } from "./merge.js";
import { projectPreferences } from "./preferences.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";

/** Host-only, idempotent, add-only risk classification of a persisted product delivery. */
export function applyAutoRiskTags(
  state: CommandState,
  actor: Actor,
  p: { delivery_id: DeliveryId },
  ports: CommandPorts,
) {
  return command(state, actor, "apply_auto_risk_tags", ports, (d) =>
    apply(d, p.delivery_id),
  );
}

function apply(d: CommandDraft, deliveryId: DeliveryId) {
  const delivery = d.get("deliveries", deliveryId);
  const item = d.work(delivery.work_item_id);
  const card = d.card(item.card_id);
  if (
    delivery.status === "superseded" ||
    delivery.kind === "card_completion" ||
    item.kind !== "produce" ||
    item.status === "cancelled" ||
    ["done", "cancelled"].includes(card.status)
  )
    return null;
  const highRisk = highRiskProducts(
    {
      project_id: d.state.project_id,
      project_preferences: d.list("project_preferences"),
      work_items: d.list("work_items"),
      deliveries: d.list("deliveries"),
    },
    card,
  ).some((w) => w.id === item.id);
  const covered = d
    .list("work_items")
    .some(
      (w) =>
        w.card_id === card.id &&
        w.kind === "verify" &&
        w.role_id === "independent_reviewer" &&
        w.required &&
        w.status !== "cancelled" &&
        !w.replaced_by_work_item_id &&
        w.target_work_item_id === item.id,
    );
  const added =
    highRisk && !covered
      ? addIndependentReviewer(d, card, item, deliveryId)
      : undefined;
  const willClassify =
    !card.risk_tags?.includes("security") &&
    autoRiskPathEvidence(delivery)?.paths.some((path) =>
      autoSecurityPaths(projectPreferences(d.state)).some((pattern) =>
        mergePathMatches(path, pattern),
      ),
    );
  if (
    !willClassify &&
    highRisk &&
    !covered &&
    !added &&
    !appendEvents(d.state.events, d.events).some(
      (e) =>
        ["high_risk_review_required", "auto_risk_tags_applied"].includes(
          e.type,
        ) &&
        (e.payload as { delivery_id?: string }).delivery_id === delivery.id &&
        (e.payload as { needs_independent_reviewer?: boolean })
          .needs_independent_reviewer === true,
    )
  )
    d.emit(
      "high_risk_review_required",
      card.id,
      {
        delivery_id: delivery.id,
        work_item_id: item.id,
        needs_independent_reviewer: true,
      },
      {
        type: "system",
        work_item_id: item.id,
        delivery_id: delivery.id,
        body: "高危交付缺少同卡必需独立复核，请项目经理补齐。",
      },
    );
  const patterns = autoSecurityPaths(projectPreferences(d.state));
  const evidence = autoRiskPathEvidence(delivery);
  if (!evidence || !validMergePathList(patterns)) return null;
  const paths = evidence.paths;
  const matched = [
    ...new Set(
      paths.filter((path) =>
        patterns.some((pattern) => mergePathMatches(path, pattern)),
      ),
    ),
  ].sort();
  if (!matched.length || card.risk_tags?.includes("security")) return null;
  // Re-read: adding a reviewer may already have withdrawn a completion.
  const next = {
    ...d.card(card.id),
    risk_tags: [...(card.risk_tags ?? []), "security" as const],
  };
  d.put("cards", next);
  const missing = !d
    .list("work_items")
    .some(
      (w) =>
        w.card_id === card.id &&
        w.kind === "verify" &&
        w.role_id === "independent_reviewer" &&
        w.required &&
        w.status !== "cancelled" &&
        !w.replaced_by_work_item_id &&
        w.target_work_item_id === item.id,
    );
  d.emit(
    "auto_risk_tags_applied",
    card.id,
    {
      delivery_id: delivery.id,
      work_item_id: item.id,
      previous_risk_tags: [...(card.risk_tags ?? [])],
      risk_tags: next.risk_tags,
      matched_paths: matched,
      path_evidence_complete: evidence.complete,
      needs_independent_reviewer: highRisk && missing,
    },
    {
      type: "system",
      delivery_id: delivery.id,
      work_item_id: item.id,
      body: `系统自动添加 security 标签；命中路径：${matched.map(displayChangedPath).join("、")}。${missing ? "请 PM Ops 补充指向本产出项的必需独立复核项；完成申请仍受原有硬门限制。" : added ? `系统已补充指向本产出项的必需独立复核项 ${added.id}。` : "保留现有独立复核要求。"}${evidence.complete ? "" : "其余路径证据无法完整判读，自动合并保持等待。"}`,
    },
  );
  syncRiskTagMerge(d, next);
  return next;
}

/**
 * C-790: a high-risk product without a covering required independent review
 * gets one from the system. Only creation is automated; the review itself,
 * reviewer separation and every merge/completion gate are unchanged. Without
 * an active independent_reviewer role the PM request remains the fallback.
 */
function addIndependentReviewer(
  d: CommandDraft,
  card: Card,
  producer: WorkItem,
  deliveryId: DeliveryId,
): WorkItem | undefined {
  if (!activeTemplateRole(d.state.roles, "independent_reviewer")) return;
  const item: WorkItem = {
    id: d.ids.next(d.state.project_id, "work_item"),
    card_id: card.id,
    kind: "verify",
    role_id: "independent_reviewer",
    title: "独立复核",
    // Like the fast-patch upgrade: a template key keeps it from being made optional.
    template_key: "independent_review",
    required: true,
    status: "todo",
    depends_on: [],
    target_work_item_id: producer.id,
    completion_criteria: [...card.acceptance_criteria],
    max_review_rounds: initialReviewMaxRounds(
      "independent_reviewer",
      projectPreferences(d.state),
    ),
  };
  d.put("work_items", item);
  d.emit(
    "work_item_created",
    card.id,
    {
      work_item_id: item.id,
      target_work_item_id: producer.id,
      delivery_id: deliveryId,
      reason: "high_risk_path",
    },
    {
      type: "system",
      work_item_id: item.id,
      delivery_id: deliveryId,
      body: `高危交付缺少同卡必需独立复核，系统已为 ${producer.id} 补充必需独立复核项 ${item.id}。`,
    },
  );
  return bindRequiredVerifier(d, item);
}

/** Derive system effects inside the same delivery draft and persistence transaction. */
export function applyDeliveryAutoRiskTags(
  d: CommandDraft,
  deliveryId: DeliveryId,
): void {
  ensure(
    d.tool === "submit_delivery" || d.tool === "request_recheck",
    "unauthorized",
    "Only delivery settlement derives risk tags",
  );
  const system = new CommandDraft(
    { ...d.state, events: appendEvents(d.state.events, d.events) },
    { kind: "system", project_id: d.state.project_id },
    "apply_auto_risk_tags",
    d.ports,
  );
  for (const c of d.changes) system.put(c.collection, c.entity);
  apply(system, deliveryId);
  for (const c of system.changes) d.put(c.collection, c.entity);
  d.events.push(...system.events);
  d.timeline.push(...system.timeline);
}
