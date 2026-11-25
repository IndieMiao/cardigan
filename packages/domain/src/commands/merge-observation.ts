import type { Actor, Card, Decision, Event } from "../entities.js";
import { eventsOfTypes } from "../event-index.js";
import type { CardId } from "../ids.js";
import { autoMergePaused } from "../preferences.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { prepareMergePlan } from "./merge.js";
import { systemMergeBlockers } from "./merge-blockers.js";
import { effectivePreMergeChecks } from "./pre-merge-check-view.js";
import { screenshotCheckEnforced } from "./screenshot-check.js";
import {
  systemMergeAuthority,
  systemMergeEnabled,
  systemMergeHumanReason,
} from "./system-merge-policy.js";

export const DEFAULT_MERGE_BLOCKED_REMINDER_MS = 30 * 60_000;

/** Readiness only: this observation never grants consent or changes a merge gate. */
export function automaticMergeReasons(
  state: CommandState,
  card: Card,
  q: Decision,
) {
  if (
    state.project_settings?.merge_gate_enabled === false ||
    card.status !== "awaiting_merge" ||
    !systemMergeEnabled(state, card)
  )
    return [];
  // Personal consent already granted is not an automatic-confirmation wait.
  if (q.status === "resolved" && q.resolution?.resolved_by === "human")
    return [];
  const reasons = [...systemMergeBlockers(state, q)];
  const plan = prepareMergePlan(state, card.id);
  if (!plan.ok) reasons.push(plan.error.message);
  if (
    autoMergePaused(
      state.project_preferences?.find((p) => p.id === state.project_id),
    )
  )
    reasons.push("自动合并已暂停");
  if (
    q.status === "snoozed" ||
    q.status === "provisional" ||
    q.resolution?.option === "hold"
  )
    reasons.push("合并确认已暂缓，等待恢复处理");
  const human = systemMergeHumanReason(state, q);
  if (human) reasons.push(human);
  if (!systemMergeAuthority(state))
    reasons.push("缺少当前项目自动合并的人授权事件");
  return [...new Set(reasons)].sort();
}

function observations(events: readonly Event[]) {
  const latest = new Map<CardId, Event>();
  for (const event of eventsOfTypes(events, [
    "merge_blocked",
    "merge_unblocked",
  ])) {
    if (
      !event.card_id ||
      event.actor.kind !== "system" ||
      !["merge_blocked", "merge_unblocked"].includes(event.type)
    )
      continue;
    if (event.seq > (latest.get(event.card_id)?.seq ?? -1))
      latest.set(event.card_id, event);
  }
  return latest;
}

/** Persistent, transactional deduplication survives restart and concurrent ticks. */
export function recordAutomaticMergeWaits(
  state: CommandState,
  actor: Actor,
  p: { readonly reminder_after_ms?: number },
  ports: CommandPorts,
) {
  return command(state, actor, "record_automatic_merge_waits", ports, (d) => {
    d.projectAccess();
    const threshold = p.reminder_after_ms ?? DEFAULT_MERGE_BLOCKED_REMINDER_MS;
    ensure(
      Number.isSafeInteger(threshold) && threshold > 0,
      "validation_failed",
      "合并阻塞提醒时长须为正整数",
    );
    const latest = observations(state.events);
    for (const card of state.cards) {
      const previous = latest.get(card.id);
      if (
        card.status !== "awaiting_merge" &&
        previous?.type !== "merge_blocked"
      )
        continue;
      const q = state.decisions
        .filter(
          (q) =>
            q.card_id === card.id &&
            q.trigger === "merge_confirmation" &&
            !["superseded", "withdrawn", "revoked"].includes(q.status),
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      const reasons = q ? automaticMergeReasons(state, card, q) : [];
      if (
        !reasons.length ||
        !q ||
        q.kind !== "approve" ||
        !("delivery_id" in q.target)
      ) {
        if (previous?.type === "merge_blocked")
          d.emit(
            "merge_unblocked",
            card.id,
            {},
            {
              type: "system",
              body: "自动合并阻塞已解除或当前合并目标已结束。",
            },
          );
        continue;
      }
      const completion_id = q.target.delivery_id;
      const fingerprint = JSON.stringify([completion_id, reasons]);
      const unchanged =
        previous?.type === "merge_blocked" &&
        (previous.payload as { fingerprint?: string }).fingerprint ===
          fingerprint;
      const started_at = unchanged ? previous.created_at : d.now;
      const referenced = new Set(
        reasons.flatMap((reason) => reason.match(/\b[A-Z]+-\d+\b/gu) ?? []),
      );
      for (const review of state.reviews)
        if (referenced.has(review.id)) referenced.add(review.work_item_id);
      const work_item_ids = state.work_items
        .filter((w) => w.card_id === card.id && referenced.has(w.id))
        .map((w) => w.id)
        .sort();
      const pre_merge_checks = effectivePreMergeChecks(
        card,
        state.work_items,
        state.deliveries,
        screenshotCheckEnforced(state),
      )
        .filter((c) => c.status !== "passed")
        .map((c) => c.label)
        .sort();
      const payload = {
        completion_id,
        decision_id: q.id,
        fingerprint,
        reasons,
        work_item_ids,
        pre_merge_checks,
        started_at,
      };
      if (!unchanged)
        d.emit("merge_blocked", card.id, payload, {
          type: "system",
          body: `自动合并等待：${reasons.join("；")}`,
          refs: [
            { kind: "decision", id: q.id },
            ...work_item_ids.map((id) => ({ kind: "work_item" as const, id })),
          ],
        });
      // Capacity/check execution and deliberate pauses need no PM workflow action.
      const pmReasons = reasons.filter(
        (reason) =>
          !reason.startsWith("合并闸门检查") &&
          !reason.includes("暂停") &&
          !reason.includes("暂缓") &&
          !reason.includes("须由人") &&
          !reason.includes("须交人") &&
          !reason.includes("人授权"),
      );
      const waited = Date.parse(d.now) - Date.parse(started_at);
      if (!pmReasons.length || !Number.isFinite(waited) || waited < threshold)
        continue;
      if (
        state.events.some(
          (e) =>
            e.card_id === card.id &&
            e.actor.kind === "system" &&
            e.type === "merge_blocked_reminded" &&
            e.seq > (previous?.seq ?? 0) &&
            (e.payload as { fingerprint?: string }).fingerprint === fingerprint,
        )
      )
        continue;
      const action = pre_merge_checks.length
        ? `请 PM 核查「${pre_merge_checks.join("、")}」的当前版本证据：普通核对项由有权记录结论的 PM Office 或人更新；独立复核及启用审核投影的截图核对由对应验证人提交审核。不能把待核直接视为通过。`
        : "请 PM 核查涉及的工作项、当前审核及未处理问题，安排对应负责人补齐。";
      const body = `自动合并已等待 ${Math.floor(waited / 60_000)} 分钟：${pmReasons.join("；")}。${action}`;
      d.emit(
        "merge_blocked_reminded",
        card.id,
        { ...payload, body },
        { type: "system", body },
      );
    }
  });
}
