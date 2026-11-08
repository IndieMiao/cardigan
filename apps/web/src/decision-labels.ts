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
  }
  return q.options.find((o) => o.key === key)?.description ?? key;
}
