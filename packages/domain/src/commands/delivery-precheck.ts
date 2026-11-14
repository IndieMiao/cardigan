import {
  type DeliveryPrecheck,
  latestDeliveryPrecheck,
} from "../delivery-precheck.js";
import type { Actor, Delivery } from "../entities.js";
import type { DeliveryId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { requestReviewLimit } from "./review-limit.js";
import { reviewRound } from "./review-round.js";

const labels: Record<DeliveryPrecheck["status"], string> = {
  queued: "排队中",
  running: "运行中",
  passed: "通过",
  failed: "测试失败",
  timed_out: "超时",
  interrupted: "中断",
  executor_unreachable: "执行器不可达",
  environment_failed: "检查环境未就绪",
};
function target(d: CommandDraft, id: DeliveryId) {
  const delivery = d.get("deliveries", id);
  const item = d.work(delivery.work_item_id);
  const card = d.card(item.card_id);
  ensure(
    delivery.kind !== "card_completion" &&
      delivery.status !== "superseded" &&
      !["done", "cancelled", "awaiting_merge"].includes(card.status) &&
      item.status !== "cancelled",
    "stale_target",
    "预检查需要当前产出交付",
  );
  return { delivery, item, card };
}
export function queueDeliveryPrecheck(
  d: CommandDraft,
  delivery: Delivery,
  via: string,
): DeliveryPrecheck {
  const check: DeliveryPrecheck = {
    delivery_id: delivery.id,
    work_item_id: delivery.work_item_id,
    subject: { ...delivery.subject },
    status: "queued",
    checks: [],
    updated_at: d.now,
  };
  d.emit(
    "delivery_precheck_requested",
    d.work(delivery.work_item_id).card_id,
    {
      ...check,
      subject: { ...check.subject },
      checks: check.checks.map((c) => ({ ...c })),
      via,
    },
    {
      type: "system",
      body: "交付预检查已排队，预检查通过后才可开始独立复核",
      delivery_id: delivery.id,
    },
  );
  return check;
}
export function requestDeliveryPrecheck(
  state: CommandState,
  actor: Actor,
  p: { delivery_id: DeliveryId },
  ports: CommandPorts,
) {
  return command(state, actor, "request_delivery_precheck", ports, (d) => {
    d.pm();
    d.projectAccess();
    const { delivery, card } = target(d, p.delivery_id);
    ensure(
      !d
        .list("deliveries")
        .some(
          (v) =>
            v.kind === "card_completion" &&
            v.status !== "superseded" &&
            d.work(v.work_item_id).card_id === card.id,
        ),
      "illegal_transition",
      "已有完成申请，请在申请完成之前请求产出预检查",
    );
    ensure(
      delivery.subject.kind === "git_head",
      "validation_failed",
      "预检查需要 Git 提交形式的交付",
    );
    const previous = latestDeliveryPrecheck(state.events, delivery);
    // A real test failure needs a new product; successful/current checks are reused.
    if (
      previous &&
      ![
        "environment_failed",
        "timed_out",
        "interrupted",
        "executor_unreachable",
      ].includes(previous.status) &&
      !(previous.status === "failed" && previous.timeout_only)
    )
      return previous;
    return queueDeliveryPrecheck(d, delivery, "manual");
  });
}
type Update = Omit<DeliveryPrecheck, "work_item_id" | "subject" | "updated_at">;
const sha = (s: string | undefined) =>
  !!s && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(s);
export function recordDeliveryPrecheck(
  state: CommandState,
  actor: Actor,
  p: Update,
  ports: CommandPorts,
) {
  return command(state, actor, "record_delivery_precheck", ports, (d) => {
    const { delivery, item, card } = target(d, p.delivery_id);
    const old = latestDeliveryPrecheck(state.events, delivery);
    ensure(old, "illegal_transition", "预检查尚未请求");
    ensure(
      [
        "queued",
        "running",
        "passed",
        "failed",
        "timed_out",
        "interrupted",
        "executor_unreachable",
        "environment_failed",
      ].includes(p.status),
      "validation_failed",
      "无效预检查状态",
    );
    const identity = [
      "attempt_id",
      "candidate_sha",
      "tree_sha",
      "base_sha",
    ] as const;
    const same = identity.every((k) => old[k] === p[k]);
    const terminal = !["queued", "running"].includes(p.status);
    if (old.status === p.status && same) {
      ensure(
        !terminal ||
          (JSON.stringify(old.checks) === JSON.stringify(p.checks) &&
            old.summary === p.summary &&
            old.log_ref === p.log_ref),
        "stale_target",
        "预检查结果不能覆盖",
      );
      return old;
    }
    if (p.status === "queued" && p.attempt_id && !same)
      ensure(
        !state.events.some(
          (e) =>
            e.type === "delivery_precheck_updated" &&
            (e.payload as { attempt_id?: string }).attempt_id === p.attempt_id,
        ),
        "validation_failed",
        "预检查执行编号不能复用",
      );
    if (p.attempt_id) {
      ensure(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(p.attempt_id) &&
          sha(p.candidate_sha) &&
          sha(p.tree_sha) &&
          sha(p.base_sha) &&
          p.candidate_sha === delivery.subject.value &&
          delivery.subject.kind === "git_head" &&
          p.tree_sha?.length === p.candidate_sha.length &&
          p.base_sha?.length === p.candidate_sha.length,
        "validation_failed",
        "预检查提交与交付不匹配",
      );
    }
    ensure(
      p.status === "queued"
        ? old.status === "queued" && !old.attempt_id && !!p.attempt_id
        : same &&
            (p.status === "running"
              ? old.status === "queued" && !!p.attempt_id
              : old.status === "running" ||
                (old.status === "queued" &&
                  [
                    "environment_failed",
                    "executor_unreachable",
                    "interrupted",
                  ].includes(p.status))),
      "stale_target",
      "预检查结果不属于当前执行",
    );
    ensure(
      p.log_ref === undefined ||
        (!!p.attempt_id && p.log_ref === `${p.attempt_id}.log`),
      "validation_failed",
      "无效日志引用",
    );
    ensure(
      !p.summary || p.summary.length <= 16000,
      "validation_failed",
      "预检查摘要过长",
    );
    ensure(
      p.checks.every(
        (c) =>
          c.name.trim() &&
          ["passed", "failed", "timed_out", "interrupted", "not_run"].includes(
            c.status,
          ) &&
          (c.exit_code == null || Number.isSafeInteger(c.exit_code)) &&
          (c.duration_ms === undefined ||
            (Number.isFinite(c.duration_ms) && c.duration_ms >= 0)),
      ),
      "validation_failed",
      "无效逐项结果",
    );
    ensure(
      p.status !== "passed" ||
        (p.checks.length > 0 &&
          p.checks.every((c) => c.status === "passed" && c.exit_code === 0)),
      "invariant_violation",
      "预检查通过需要全部命令成功",
    );
    ensure(
      p.status !== "failed" || p.checks.some((c) => c.status === "failed"),
      "invariant_violation",
      "只有真实命令失败才能退回作者",
    );
    ensure(
      p.timeout_only === undefined ||
        (typeof p.timeout_only === "boolean" &&
          (!p.timeout_only ||
            (["failed", "timed_out"].includes(p.status) &&
              p.checks.some((c) =>
                ["failed", "timed_out"].includes(c.status),
              ) &&
              p.checks.every((c) =>
                ["passed", "failed", "timed_out", "not_run"].includes(c.status),
              )))),
      "validation_failed",
      "无效的纯超时分类",
    );
    const value: DeliveryPrecheck = {
      ...p,
      work_item_id: item.id,
      subject: { ...delivery.subject },
      updated_at: d.now,
    };
    d.emit(
      "delivery_precheck_updated",
      card.id,
      {
        ...value,
        subject: { ...value.subject },
        checks: value.checks.map((c) => ({ ...c })),
      },
      {
        type: "system",
        body: `交付预检查${labels[p.status]}${p.summary ? `：${p.summary}` : ""}`,
        delivery_id: delivery.id,
      },
    );
    if (p.status === "passed")
      for (const w of d.list("work_items")) {
        if (
          w.kind === "verify" &&
          delivery.requested_verifiers.includes(w.id) &&
          w.status === "ready" &&
          reviewRound(d, w, delivery) > w.max_review_rounds
        )
          requestReviewLimit(d, w);
      }
    if (
      p.status === "failed" &&
      !p.timeout_only &&
      ["submitted", "accepted"].includes(delivery.status)
    ) {
      if (delivery.status === "accepted") {
        d.put("deliveries", {
          ...delivery,
          status: unwrap(
            transition("delivery", delivery.status, "precheck_failed"),
          ),
        });
        if (item.status === "accepted")
          d.put("work_items", d.move(item, "precheck_failed"));
      } else {
        d.put("deliveries", {
          ...delivery,
          status: unwrap(transition("delivery", delivery.status, "reject")),
        });
        if (item.status === "delivered")
          d.put("work_items", d.move(item, "review_rejected"));
      }
      d.emit(
        "delivery_precheck_rejected",
        card.id,
        { delivery_id: delivery.id, work_item_id: item.id },
        {
          type: "system",
          body: "预检查发现测试失败，退回作者修复；未消耗独立复核轮数",
          work_item_id: item.id,
          delivery_id: delivery.id,
        },
      );
    }
    if (
      p.timeout_only &&
      ["failed", "timed_out"].includes(p.status) &&
      !state.events.some(
        (e) =>
          e.type === "delivery_precheck_requested" &&
          (e.payload as { delivery_id?: string; via?: string }).delivery_id ===
            delivery.id &&
          (e.payload as { via?: string }).via === "timeout_auto_rerun",
      )
    )
      queueDeliveryPrecheck(d, delivery, "timeout_auto_rerun");
    return value;
  });
}

/** Recovery follows the existing interrupted/unreachable check policy. */
export function retryDeliveryPrecheck(
  state: CommandState,
  actor: Actor,
  p: { delivery_id: DeliveryId },
  ports: CommandPorts,
) {
  return command(state, actor, "record_delivery_precheck", ports, (d) => {
    const { delivery } = target(d, p.delivery_id);
    const old = latestDeliveryPrecheck(state.events, delivery);
    ensure(
      old && ["interrupted", "executor_unreachable"].includes(old.status),
      "illegal_transition",
      "预检查不允许自动重试",
    );
    return queueDeliveryPrecheck(d, delivery, "recovery");
  });
}

/** End obsolete execution bookkeeping without accepting its result for any delivery. */
export function settleDeliveryPrecheck(
  state: CommandState,
  actor: Actor,
  p: { delivery_id: DeliveryId; attempt_id: string },
  ports: CommandPorts,
) {
  return command(state, actor, "record_delivery_precheck", ports, (d) => {
    const delivery = d.get("deliveries", p.delivery_id),
      item = d.get("work_items", delivery.work_item_id),
      card = d.get("cards", item.card_id);
    ensure(
      delivery.status === "superseded" ||
        item.status === "cancelled" ||
        ["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "当前交付不能按旧执行收尾",
    );
    const old = latestDeliveryPrecheck(state.events, delivery);
    if (
      !old ||
      old.attempt_id !== p.attempt_id ||
      !["queued", "running"].includes(old.status)
    )
      return null;
    const value = {
      ...old,
      status: "interrupted" as const,
      summary: "旧交付预检查已结束，不用于当前交付",
      updated_at: d.now,
    };
    d.emit(
      "delivery_precheck_settled",
      card.id,
      {
        ...value,
        subject: { ...value.subject },
        checks: value.checks.map((c) => ({ ...c })),
      },
      { type: "system", body: value.summary, delivery_id: delivery.id },
    );
    return value;
  });
}
