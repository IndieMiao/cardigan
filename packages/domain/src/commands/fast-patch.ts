import { autoRiskPathEvidence } from "../auto-risk.js";
import type { Delivery } from "../entities.js";
import type { CardId } from "../ids.js";
import {
  highRiskPaths,
  initialReviewMaxRounds,
  mergePathMatches,
  validMergePathList,
} from "../preferences.js";
import { transition } from "../transitions.js";
import { CommandDraft, unwrap } from "./core.js";
import { projectPreferences } from "./preferences.js";

/** Called only with host-verified delivery evidence, before accepting a product. */
export function upgradeFastPatch(
  d: CommandDraft,
  product: Pick<Delivery, "work_item_id" | "kind" | "subject" | "evidence">,
) {
  const item = d.work(product.work_item_id);
  const card = d.card(item.card_id);
  if (
    card.template !== "fast_patch" ||
    card.template_version !== 1 ||
    product.kind === "card_completion"
  )
    return [];
  const preferences = projectPreferences(d.state);
  const patterns = highRiskPaths(preferences);
  const evidence = autoRiskPathEvidence(product);
  const known =
    d.state.project_preferences !== undefined &&
    validMergePathList(patterns) &&
    evidence?.complete === true;
  if (
    known &&
    !card.high_risk &&
    !evidence.paths.some((path) =>
      patterns.some((pattern) => mergePathMatches(path, pattern)),
    )
  )
    return [];
  const system = new CommandDraft(
    d.state,
    { kind: "system", project_id: d.state.project_id },
    "apply_auto_risk_tags",
    d.ports,
  );
  for (const change of d.changes) system.put(change.collection, change.entity);
  system.put("cards", { ...card, template: "dev", template_version: 2 });
  const verifiers = [];
  for (const [key, role, title] of [
    ["code_review", "reviewer", "代码审核"],
    ["independent_review", "independent_reviewer", "独立复核"],
  ] as const) {
    const existing = system
      .list("work_items")
      .find(
        (w) =>
          w.card_id === card.id &&
          w.kind === "verify" &&
          w.target_work_item_id === item.id &&
          w.role_id === role &&
          !w.replaced_by_work_item_id &&
          w.status !== "cancelled",
      );
    const verifier = existing
      ? { ...existing, required: true }
      : {
          id: d.ids.next(d.state.project_id, "work_item"),
          card_id: card.id,
          kind: "verify" as const,
          role_id: role,
          title,
          template_key: key,
          required: true,
          status: "todo" as const,
          depends_on: [],
          target_work_item_id: item.id,
          completion_criteria: [...card.acceptance_criteria],
          max_review_rounds: initialReviewMaxRounds(role, preferences),
        };
    system.put("work_items", verifier);
    verifiers.push(verifier.id);
  }
  const reason = known
    ? "当前交付命中项目高危路径或卡片被人标记为高危"
    : "无法完整确认当前交付的主机路径证据或高危路径配置";
  system.emit(
    "fast_patch_upgraded",
    card.id,
    {
      work_item_id: item.id,
      sha: product.subject.value,
      previous_template: "fast_patch",
      previous_template_version: 1,
      template: "dev",
      template_version: 2,
      requested_verifiers: verifiers,
      reason,
    },
    {
      type: "system",
      work_item_id: item.id,
      body: `快速补丁已自动转为普通开发通道：${reason}；补齐必需代码审核和独立复核，保留已有人员身份。`,
    },
  );
  for (const change of system.changes) d.put(change.collection, change.entity);
  d.events.push(...system.events);
  d.timeline.push(...system.timeline);
  return verifiers;
}

/** Re-evaluate accepted fast patches when human risk/configuration changes. */
export function refreshFastPatch(d: CommandDraft, cardId: CardId) {
  const card = d.card(cardId);
  if (
    card.template !== "fast_patch" ||
    ["done", "cancelled"].includes(card.status)
  )
    return;
  for (const product of d.list("deliveries")) {
    if (
      product.kind === "card_completion" ||
      product.status !== "accepted" ||
      d.work(product.work_item_id).card_id !== card.id
    )
      continue;
    const added = upgradeFastPatch(d, product);
    if (!added.length) continue;
    d.put("deliveries", {
      ...product,
      status: unwrap(transition("delivery", product.status, "require_review")),
      requested_verifiers: [
        ...new Set([...product.requested_verifiers, ...added]),
      ],
    });
    const item = d.work(product.work_item_id);
    if (item.status === "accepted")
      d.put("work_items", d.move(item, "delivery_submitted"));
    for (const id of added) {
      const verifier = d.work(id);
      if (verifier.status === "todo")
        d.put("work_items", d.move(verifier, "target_delivered"));
    }
  }
}
