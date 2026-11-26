import type { Actor, Delivery, WorkItem } from "../entities.js";
import type { Result } from "../errors.js";
import type { CardId, WorkItemId } from "../ids.js";
import { isCompletionVerifier } from "../templates.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { isPmOps } from "./delegation.js";
import { supersedeDelivery } from "./delivery-invalidation.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { invalidateReviewReuse } from "./review-reuse.js";
import { resolveCardTemplate } from "./templates.js";

export interface ReplacePrimaryWorkItemParams {
  /** The template's current primary producer that gives up the slot. */
  readonly work_item_id: WorkItemId;
  /** An existing producer on the same card that takes the slot over. */
  readonly replacement_work_item_id: WorkItemId;
  /** Expected scope and template identity, checked against the fresh snapshot. */
  readonly card_id: CardId;
  readonly template_key: string;
  readonly reason: string;
}

const RUN_FINISHED = ["completed", "failed", "cancelled"];
const VERDICT_STATUSES = ["ready", "in_progress", "failed", "passed"];

/**
 * C-778: move the template's primary production slot from a mis-assigned
 * producer to another producer on the same card. The slot is transferred,
 * never emptied: exactly one open item holds the template key afterwards and
 * it stays required. The replacement keeps its own deliveries and the reviews
 * aimed at it; verifiers that targeted the retired item follow the slot and
 * must review the replacement again.
 */
export function replacePrimaryWorkItem(
  state: CommandState,
  actor: Actor,
  p: ReplacePrimaryWorkItemParams,
  ports: CommandPorts,
): Result<CommandEffect<WorkItem>> {
  return command(state, actor, "replace_primary_work_item", ports, (d) => {
    ensure(
      actor.kind === "human" || isPmOps(d),
      "forbidden_tool",
      "只有常驻 PM Ops 或人可以替换主产出项",
    );
    ensure(
      typeof p.reason === "string" && p.reason.trim(),
      "validation_failed",
      "替换原因不能为空",
    );
    const old = d.list("work_items").find((w) => w.id === p.work_item_id);
    ensure(old, "not_found", "原主产出项不存在");
    const next = d
      .list("work_items")
      .find((w) => w.id === p.replacement_work_item_id);
    ensure(next, "not_found", "新产出项不存在");
    ensure(
      old.card_id === p.card_id && next.card_id === p.card_id,
      "validation_failed",
      "新旧产出项必须属于指定的同一卡片",
    );
    ensure(old.id !== next.id, "validation_failed", "新旧产出项不能相同");
    const card = d.card(old.card_id);
    ensure(
      !["done", "cancelled", "awaiting_merge"].includes(card.status),
      "illegal_transition",
      "卡片已关闭或待合并；待合并时须先按现有流程退回修改",
    );
    const template = resolveCardTemplate(d, card);
    const key = template.primary_work_item_key;
    ensure(
      key !== null &&
        card.template === template.id &&
        p.template_key === key &&
        old.kind === "produce" &&
        old.template_key === key,
      "validation_failed",
      "原项必须是卡片固定模板中的主产出项，且 template_key 与之一致",
    );
    ensure(
      !old.replaced_by_work_item_id,
      "illegal_transition",
      "原主产出项已经被替换",
    );
    ensure(
      next.kind === "produce",
      "validation_failed",
      "新项必须是同卡的产出项",
    );
    ensure(
      next.status !== "cancelled" && !next.replaced_by_work_item_id,
      "illegal_transition",
      "新产出项已取消或已被替换",
    );
    ensure(
      next.template_key === undefined,
      "validation_failed",
      "新产出项已占用模板槽位，不能再接收主产出槽位",
    );
    const owners = d
      .list("assignments")
      .filter((a) => a.scope === "work_item" && a.work_item_id === old.id);
    ensure(
      owners.every((a) => a.status === "released"),
      "illegal_transition",
      "原主产出项仍有未释放的 Assignment，请先结束其 Run 并释放",
    );
    const ownerIds = new Set(owners.map((a) => a.id));
    ensure(
      d
        .list("runs")
        .every(
          (r) =>
            !ownerIds.has(r.assignment_id) || RUN_FINISHED.includes(r.status),
        ),
      "illegal_transition",
      "原主产出项仍有未结束的 Run，请先结束并释放",
    );

    // The retired item's versions and the card's completion request are no
    // longer valid; the replacement's own deliveries stay untouched.
    const invalidated = d
      .list("deliveries")
      .filter(
        (v) =>
          v.status !== "superseded" &&
          (v.work_item_id === old.id ||
            (v.kind === "card_completion" &&
              d.work(v.work_item_id).card_id === card.id)),
      );
    withdrawDeliveries(d, invalidated);

    const followers = d
      .list("work_items")
      .filter(
        (w): w is Extract<WorkItem, { kind: "verify" }> =>
          w.card_id === card.id &&
          w.kind === "verify" &&
          !w.replaced_by_work_item_id &&
          w.status !== "cancelled" &&
          w.target_work_item_id === old.id,
      );
    for (const verifier of followers) {
      const moved = VERDICT_STATUSES.includes(verifier.status)
        ? d.move(verifier, "target_withdrawn")
        : verifier;
      ensure(
        moved.kind === "verify" && moved.status === "todo",
        "illegal_transition",
        `指向原主产出项的验证项 ${verifier.id} 正在阻塞或等待拍板，请先处理`,
      );
      d.put("work_items", { ...moved, target_work_item_id: next.id });
    }

    let retired = d.work(old.id);
    if (retired.status !== "cancelled") retired = d.move(retired, "cancel");
    const { template_key: _slot, ...historical } = retired;
    d.put("work_items", {
      ...historical,
      required: false,
      replaced_by_work_item_id: next.id,
    });
    const holder: WorkItem = {
      ...d.work(next.id),
      template_key: key,
      required: true,
      depends_on: d.work(next.id).depends_on.filter((id) => id !== old.id),
    };
    d.put("work_items", holder);
    // Dependencies keep referring to the active obligation, not a cancelled predecessor.
    for (const item of d.list("work_items"))
      if (
        item.card_id === card.id &&
        item.id !== next.id &&
        !item.replaced_by_work_item_id &&
        item.depends_on.includes(old.id)
      )
        d.put("work_items", {
          ...item,
          depends_on: [
            ...new Set(
              item.depends_on.map((id) => (id === old.id ? next.id : id)),
            ),
          ],
        });

    // Invariants 15/16: reviewers that now face the replacement, including the
    // completion acceptance, must still be separated from its authors.
    for (const verifier of d.list("work_items")) {
      if (
        verifier.card_id !== card.id ||
        verifier.kind !== "verify" ||
        verifier.replaced_by_work_item_id ||
        verifier.status === "cancelled" ||
        !(
          verifier.target_work_item_id === next.id ||
          isCompletionVerifier(template, verifier)
        )
      )
        continue;
      for (const a of d.list("assignments"))
        if (a.scope === "work_item" && a.work_item_id === verifier.id)
          checkEmployeeSeparation(d, verifier, a.employee_id);
    }

    const reason = p.reason.trim();
    const operator = actor.kind === "assignment" ? actor.assignment_id : "人";
    d.emit(
      "primary_work_item_replaced",
      card.id,
      {
        work_item_id: old.id,
        replacement_work_item_id: next.id,
        template_key: key,
        reason,
        retargeted_verifiers: followers.map((w) => w.id),
        superseded_deliveries: invalidated.map((v) => v.id),
      },
      {
        type: "status_change",
        work_item_id: next.id,
        body: `${operator} 把主产出槽位 ${key} 从 ${old.id} 转给 ${next.id}：${reason}。${old.id} 已取消。${
          followers.length
            ? `原指向 ${old.id} 的验证项 ${followers.map((w) => w.id).join("、")} 改为审核 ${next.id}，须对其重新交付。`
            : ""
        }${invalidated.length ? "受影响交付和完成申请已作废，须重新提交完成申请。" : "请由新项提交完成申请。"}`,
        refs: [
          { kind: "work_item", id: old.id },
          { kind: "work_item", id: next.id },
        ],
      },
    );
    invalidateReviewReuse(d);
    return d.work(next.id);
  });
}

/** Withdraw versions; pending completion decisions close, their verifiers reset. */
function withdrawDeliveries(
  d: CommandDraft,
  deliveries: readonly Delivery[],
): void {
  for (const delivery of deliveries) {
    const card = d.card(d.work(delivery.work_item_id).card_id);
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
          status: unwrap(transition("decision", decision.status, "supersede")),
        });
    for (const id of delivery.requested_verifiers) {
      const verifier = d.work(id);
      if (VERDICT_STATUSES.includes(verifier.status))
        d.put("work_items", d.move(verifier, "target_withdrawn"));
    }
  }
}
