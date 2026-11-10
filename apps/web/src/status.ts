import type { CardStatus, NextOwnerItem } from "./api.js";

/**
 * Status vocabulary for the board (development plan §8.7: 按状态分列; M5 plan
 * §3.7 and C-48: 状态用形状、文字加颜色).
 *
 * Every status renders its Chinese label next to the colour, so the board stays
 * readable in a screenshot, in greyscale and for a colour-blind reader.
 */

export const BOARD_STATUSES: readonly CardStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "awaiting_merge",
  "done",
  "cancelled",
];

export const CARD_STATUS_LABELS: Readonly<Record<CardStatus, string>> = {
  backlog: "待整理",
  todo: "待开始",
  in_progress: "进行中",
  review: "审核中",
  awaiting_merge: "待合并",
  done: "已完成",
  cancelled: "已取消",
};

export const STATUS_LABELS = {
  ...CARD_STATUS_LABELS,
  ready: "就绪",
  delivered: "已交付",
  accepted: "已接受",
  passed: "已通过",
  failed: "失败",
  changes_requested: "需返工",
  blocked: "阻塞",
  waiting_decision: "等待拍板",
  submitted: "待审核",
  rejected: "已驳回",
  superseded: "已取代",
  open: "待拍板",
  provisional: "暂定",
  resolved: "已拍板",
  withdrawn: "已撤回",
  revoked: "已撤销",
  active: "有效",
  suspended: "已暂停",
  released: "已释放",
  not_provisioned: "未启动",
  provisioning: "启动中",
  idle: "空闲",
  running: "运行中",
  unknown: "状态未知",
  lost: "失联",
  queued: "排队中",
  dispatched: "已派发",
  acked: "已签收",
  completed: "已完成",
  online: "在线",
  offline: "离线",
  draining: "停止接收新任务",
  degraded: "运行异常",
  pass: "已通过",
  approve: "已通过",
  reject: "已驳回",
  conditional: "有条件通过",
  pending: "待投递",
  belled: "已投递",
  delivery_failed: "投递失败",
  needs_attention: "需要关注",
  timed_out: "超时",
  interrupted: "已中断",
  not_run: "未运行",
} as const;
export function statusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status)
    ? STATUS_LABELS[status as keyof typeof STATUS_LABELS]
    : "状态未知";
}
export const cardStatusLabel = statusLabel;

/** Who acts next, in the words the card page uses. */
export function nextOwnerLabel(owner: NextOwnerItem): string {
  if (owner.employee) return owner.employee.name;
  if (owner.kind === "human") return "你";
  if (owner.kind === "role") return owner.ref;
  return `${owner.ref} Assignment`;
}

export function nextOwnersLabel(owners: readonly NextOwnerItem[]): string {
  if (owners.length === 0) return "无人";
  return owners.map(nextOwnerLabel).join("、");
}
