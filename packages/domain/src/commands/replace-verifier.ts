import type { Actor, WorkItem } from "../entities.js";
import type { Result } from "../errors.js";
import type { CardId, WorkItemId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { isPmOps } from "./delegation.js";
import { supersedeDelivery } from "./delivery-invalidation.js";
import { resolveCardTemplate } from "./templates.js";

export interface ReplaceVerificationWorkItemParams {
  readonly work_item_id: WorkItemId;
  /** Expected scope and template identity, checked against the fresh snapshot. */
  readonly card_id: CardId;
  readonly template_key: string;
  readonly reason: string;
}

export function replaceVerificationWorkItem(
  state: CommandState,
  actor: Actor,
  p: ReplaceVerificationWorkItemParams,
  ports: CommandPorts,
): Result<CommandEffect<WorkItem>> {
  return command(state, actor, "replace_verification_work_item", ports, (d) => {
    ensure(
      actor.kind === "human" || isPmOps(d),
      "forbidden_tool",
      "只有常驻 PM Ops 或人可以替换验证项",
    );
    const old = d.list("work_items").find((w) => w.id === p.work_item_id);
    ensure(old, "not_found", "原验证项不存在");
    ensure(
      old.kind === "verify",
      "validation_failed",
      "只能替换验证项，不能替换产出项",
    );
    ensure(
      old.card_id === p.card_id,
      "validation_failed",
      "新旧验证项必须属于同一卡片",
    );
    const card = d.card(old.card_id);
    ensure(
      !["done", "cancelled", "awaiting_merge"].includes(card.status),
      "illegal_transition",
      "卡片已关闭或待合并；待合并时须先按现有流程退回修改",
    );
    ensure(
      !old.replaced_by_work_item_id,
      "illegal_transition",
      "原验证项已经被替换",
    );
    ensure(
      typeof p.reason === "string" && p.reason.trim(),
      "validation_failed",
      "替换原因不能为空",
    );
    const template = resolveCardTemplate(d, card);
    const definition = template.work_items.find(
      (w) => w.key === old.template_key,
    );
    ensure(
      old.template_key &&
        old.template_key === p.template_key &&
        definition?.kind === "verify" &&
        definition.role_id === old.role_id,
      "validation_failed",
      "新旧验证项必须使用卡片固定模板中的同一验证项 key 和角色",
    );
    const target = old.target_work_item_id
      ? d.work(old.target_work_item_id)
      : undefined;
    ensure(
      definition.target_work_item_key
        ? target?.kind === "produce" &&
            target.card_id === card.id &&
            target.template_key === definition.target_work_item_key
        : target === undefined,
      "validation_failed",
      "原验证目标与卡片模板不一致",
    );
    const assignment = old.assignment_id
      ? d.list("assignments").find((a) => a.id === old.assignment_id)
      : undefined;
    ensure(
      old.status === "cancelled" ||
        (assignment?.scope === "work_item" &&
          assignment.work_item_id === old.id &&
          assignment.status === "released"),
      "illegal_transition",
      "原验证项须已取消，或其 Assignment 已释放",
    );

    // Never repoint an Assignment. The replacement starts without any identity,
    // review or blocker; historical records remain attached to the original.
    const replacement: WorkItem = {
      id: d.ids.next(state.project_id, "work_item"),
      card_id: old.card_id,
      kind: "verify",
      title: old.title,
      role_id: old.role_id,
      template_key: old.template_key,
      required: old.required,
      depends_on: [...old.depends_on],
      completion_criteria: [...old.completion_criteria],
      max_review_rounds: old.max_review_rounds,
      ...(old.target_work_item_id
        ? { target_work_item_id: old.target_work_item_id }
        : {}),
      status: "todo",
    };
    // Withdraw version-bound approvals rather than editing requested_verifiers.
    // A targeted product must be delivered again; completion always needs a new request.
    const invalidated = d
      .list("deliveries")
      .filter(
        (v) =>
          v.status !== "superseded" &&
          d.work(v.work_item_id).card_id === card.id &&
          (v.kind === "card_completion" ||
            v.requested_verifiers.includes(old.id)),
      );
    for (const delivery of invalidated) {
      supersedeDelivery(d, card, delivery);
      for (const decision of d.list("decisions"))
        if (
          decision.trigger === "completion_review" &&
          decision.kind === "approve" &&
          "delivery_id" in decision.target &&
          decision.target.delivery_id === delivery.id &&
          decision.status === "open"
        )
          d.put("decisions", {
            ...decision,
            status: unwrap(
              transition("decision", decision.status, "supersede"),
            ),
          });
      for (const id of delivery.requested_verifiers) {
        const verifier = d.work(id);
        if (
          ["ready", "in_progress", "failed", "passed"].includes(verifier.status)
        )
          d.put("work_items", d.move(verifier, "target_withdrawn"));
      }
    }
    let retired = d.work(old.id);
    if (retired.status === "passed")
      retired = d.move(retired, "target_withdrawn");
    if (retired.status !== "cancelled") retired = d.move(retired, "cancel");
    d.put("work_items", {
      ...retired,
      required: false,
      replaced_by_work_item_id: replacement.id,
    });
    d.put("work_items", replacement);
    // Dependencies keep referring to the active obligation, not a cancelled predecessor.
    for (const item of d.list("work_items"))
      if (
        item.card_id === card.id &&
        !item.replaced_by_work_item_id &&
        item.depends_on.includes(old.id)
      )
        d.put("work_items", {
          ...item,
          depends_on: [
            ...new Set(
              item.depends_on.map((id) =>
                id === old.id ? replacement.id : id,
              ),
            ),
          ],
        });
    d.emit(
      "work_item_replaced",
      card.id,
      {
        work_item_id: old.id,
        replacement_work_item_id: replacement.id,
        template_key: old.template_key,
        target_work_item_id: old.target_work_item_id ?? null,
        reason: p.reason.trim(),
        superseded_deliveries: invalidated.map((v) => v.id),
      },
      {
        type: "status_change",
        work_item_id: replacement.id,
        body: `验证项 ${old.id} 已由 ${replacement.id} 替换：${p.reason.trim()}。请指派新项，并重新提交受影响交付及完成申请。`,
        refs: [
          { kind: "work_item", id: old.id },
          { kind: "work_item", id: replacement.id },
        ],
      },
    );
    return replacement;
  });
}
