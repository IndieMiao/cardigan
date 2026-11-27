import { decisionOtherOption, isDecisionOther } from "@cardigan/domain";
import type { DecisionView } from "./api.js";

export function decisionTitle(
  q: Pick<DecisionView, "question" | "trigger">,
): string {
  if (q.trigger !== "merge_confirmation") return q.question;
  const match = /^Merge\s+(.+?)\s+into\s+(.+?)\??$/u.exec(q.question);
  return match ? `确认把 ${match[1]} 合并到 ${match[2]}？` : q.question;
}
const reviewLimitLabels: Readonly<Record<string, string>> = {
  pause: "暂停",
  raise_limit: "增加轮数",
  change_approach: "换做法",
  narrow_scope: "收窄范围",
  split_card: "拆卡",
};
const reworkLabels: Readonly<Record<string, string>> = {
  return_for_rework: "退回作者修改",
  keep: "保留当前产出",
};
/** The Chinese name of an option; the stored key is never shown (C-810). */
export function decisionOption(
  q: Pick<DecisionView, "trigger" | "options">,
  key: string,
): string {
  if (isDecisionOther(key)) return decisionOtherOption.description;
  if (q.trigger === "merge_confirmation") {
    if (key === "merge") return "确认合并";
    if (key === "hold") return "暂不合并";
    if (key === "request_changes") return "退回修改";
  }
  const fixed =
    q.trigger === "review_limit"
      ? reviewLimitLabels[key]
      : q.trigger === "accepted_delivery_rework"
        ? reworkLabels[key]
        : undefined;
  return fixed ?? (q.options.find((o) => o.key === key)?.description || key);
}
/** The stored description when the option shows a fixed short name. */
export function decisionOptionNote(
  q: Pick<DecisionView, "trigger" | "options">,
  key: string,
): string | undefined {
  const description = q.options.find((o) => o.key === key)?.description;
  return description && description !== decisionOption(q, key)
    ? description
    : undefined;
}

export const categoryLabels: Readonly<Record<string, string>> = {
  general: "流程",
  feature_detail: "功能细节",
  scope_change: "需求范围变化",
  spending: "花钱",
  account: "账号",
  permission: "权限",
  data_deletion: "删除数据",
  credential: "凭据",
  publish: "对外发布",
};
export const delegableCategories = [
  "general",
  "feature_detail",
  "scope_change",
];
export const defaultDelegation: Readonly<Record<string, boolean>> = {
  general: true,
  feature_detail: true,
  scope_change: true,
  permission: true,
};
