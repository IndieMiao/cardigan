import type { Actor, Card } from "../entities.js";
import {
  cardFlowVersion,
  FLOW_VERSION_MAX,
  validFlowVersion,
} from "../flow.js";
import type { CardId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { reconcileFlowReviewLimits } from "./flow-review-limit.js";
import { resolveCardTemplate, validateTemplateFlow } from "./templates.js";

/** Human-only; the caller persists this effect in the same fresh write transaction. */
export function upgradeCardFlow(
  state: CommandState,
  actor: Actor,
  input: { card_id: CardId; to: number },
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_card_flow", ports, (d) => {
    ensure(
      validFlowVersion(input.to),
      "validation_failed",
      `流程版本须为 1 到 ${FLOW_VERSION_MAX} 的整数，后续流程尚未开放`,
    );
    const card = d.card(input.card_id);
    ensure(
      !["done", "cancelled", "awaiting_merge"].includes(card.status),
      "illegal_transition",
      "已完成、已取消或待合并的卡片不能变更流程版本",
    );
    const workIds = new Set(
      d
        .list("work_items")
        .filter((w) => w.card_id === card.id)
        .map((w) => w.id),
    );
    ensure(
      !d
        .list("deliveries")
        .some(
          (v) =>
            workIds.has(v.work_item_id) &&
            v.kind === "card_completion" &&
            v.status !== "superseded",
        ),
      "illegal_transition",
      "卡片有未作废的完成申请，不能变更流程版本",
    );
    // Attempts for one completion are serialized by recordMergeCheck. A recheck
    // request keeps the finished attempt ID until a new attempt consumes it, so
    // only the latest event for that completion describes its pending work.
    const checks = new Map<string, { seq: number; status: unknown }>();
    for (const event of state.events) {
      if (
        event.card_id !== card.id ||
        ![
          "merge_check_queued",
          "merge_check_started",
          "merge_check_finished",
          "merge_check_requeued",
        ].includes(event.type)
      )
        continue;
      const payload = event.payload as {
        completion_id: string;
        status: unknown;
      };
      if ((checks.get(payload.completion_id)?.seq ?? -1) < event.seq)
        checks.set(payload.completion_id, {
          seq: event.seq,
          status: payload.status,
        });
    }
    ensure(
      ![...checks.values()].some((check) =>
        ["queued", "running"].includes(String(check.status)),
      ),
      "illegal_transition",
      "卡片有排队中或运行中的检查，不能变更流程版本",
    );
    const before = cardFlowVersion(card);
    ensure(
      input.to >= before || ["backlog", "todo"].includes(card.status),
      "illegal_transition",
      "只有待规划或待开始的卡片可以降低流程版本",
    );
    validateTemplateFlow(resolveCardTemplate(d, card), input.to);
    if (before === input.to) return card;
    if (input.to >= 3 && input.to > before) {
      for (const item of d
        .list("work_items")
        .filter(
          (w) =>
            w.card_id === card.id &&
            w.kind === "produce" &&
            w.status !== "cancelled",
        )) {
        const assignment = d
          .list("assignments")
          .find((a) => a.id === item.assignment_id && a.status === "active");
        if (!assignment) continue;
        const role = state.roles.find(
          (r) =>
            r.role_id === assignment.role_id &&
            r.role_version === assignment.role_version,
        );
        ensure(
          !assignment.role_upgrade &&
            ["request_check", "get_check_log"].every((tool) =>
              role?.allowed_tools.includes(
                tool as "request_check" | "get_check_log",
              ),
            ),
          "illegal_transition",
          `${assignment.id} 的角色 v${assignment.role_version} 缺少预检工具或正在升级；请等待空闲角色升级完成后重试流程升级`,
        );
      }
    }
    const next: Card = { ...card, flow_version: input.to };
    d.put("cards", next);
    d.emit(
      "card_flow_upgraded",
      card.id,
      {
        card_id: card.id,
        old_value: before,
        new_value: input.to,
        upgraded_by: d.author,
      },
      {
        type: "status_change",
        body: `人将卡片流程版本从 ${before} 调整为 ${input.to}`,
      },
    );
    if (input.to >= 5) reconcileFlowReviewLimits(d, card.id);
    return next;
  });
}
