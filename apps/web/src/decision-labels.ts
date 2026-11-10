import type { DecisionView } from "./api.js";

export function decisionTitle(
  q: Pick<DecisionView, "question" | "trigger">,
): string {
  if (q.trigger !== "merge_confirmation") return q.question;
  const match = /^Merge\s+(.+?)\s+into\s+(.+?)\??$/u.exec(q.question);
  return match ? `确认把 ${match[1]} 合并到 ${match[2]}？` : q.question;
}
export function decisionOption(q: DecisionView, key: string): string {
  if (q.trigger === "merge_confirmation") {
    if (key === "merge") return "确认合并";
    if (key === "hold") return "暂不合并";
    if (key === "request_changes") return "退回修改";
  }
  return q.options.find((o) => o.key === key)?.description ?? key;
}

export const categoryLabels: Readonly<Record<string, string>> = {
  general: "流程",
  feature_detail: "功能细节",
  scope_change: "需求范围变化",
  spending: "花钱",
  account: "账号",
  permission: "权限",
  data_deletion: "删除数据",
};
export const delegableCategories = [
  "general",
  "feature_detail",
  "scope_change",
];
export const defaultDelegation: Readonly<Record<string, boolean>> = {
  general: true,
  feature_detail: true,
  scope_change: false,
};
