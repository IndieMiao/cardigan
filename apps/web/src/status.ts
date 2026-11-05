import type { CardStatus, NextOwnerItem } from "./api.js";

/**
 * Status vocabulary for the board (development plan §8.7: 按状态分列; M5 plan
 * §3.7: 状态用文字加颜色).
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

export function cardStatusLabel(status: string): string {
  return CARD_STATUS_LABELS[status as CardStatus] ?? status;
}

/** Who acts next, in the words the card page uses. */
export function nextOwnerLabel(owner: NextOwnerItem): string {
  if (owner.kind === "human") return "你";
  if (owner.kind === "role") return owner.ref;
  return owner.ref;
}

export function nextOwnersLabel(owners: readonly NextOwnerItem[]): string {
  if (owners.length === 0) return "无人";
  return owners.map(nextOwnerLabel).join("、");
}
