import { autoRiskPathEvidence } from "../auto-risk.js";
import type { Actor } from "../entities.js";
import type { DeliveryId } from "../ids.js";
import {
  autoSecurityPaths,
  mergePathMatches,
  validMergePathList,
} from "../preferences.js";
import {
  CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { syncRiskTagMerge } from "./merge.js";
import { projectPreferences } from "./preferences.js";

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
  const next = {
    ...card,
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
      needs_independent_reviewer: missing,
    },
    {
      type: "system",
      delivery_id: delivery.id,
      work_item_id: item.id,
      body: `系统自动添加 security 标签；命中路径：${matched.join("、")}。${missing ? "请 PM Ops 补充指向本产出项的必需独立复核项；完成申请仍受原有硬门限制。" : "保留现有独立复核要求。"}${evidence.complete ? "" : "其余路径证据无法完整判读，新版流程仍须交人确认。"}`,
    },
  );
  syncRiskTagMerge(d, next);
  return next;
}

/** Derive system effects inside the same delivery draft and persistence transaction. */
export function applyDeliveryAutoRiskTags(
  d: CommandDraft,
  deliveryId: DeliveryId,
): void {
  ensure(
    d.tool === "submit_delivery",
    "unauthorized",
    "Only delivery settlement derives risk tags",
  );
  const system = new CommandDraft(
    { ...d.state, events: [...d.state.events, ...d.events] },
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
