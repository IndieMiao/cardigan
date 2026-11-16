import type { Decision } from "./entities.js";

/** Group presentation only: no shared resolution, option mapping or lost blockers. */
export function humanDecisionGroupKey(q: Decision): string | undefined {
  return q.handoff_group &&
    q.decider === "human" &&
    ["open", "provisional", "snoozed"].includes(q.status)
    ? q.handoff_group
    : undefined;
}

export function groupHumanDecisions<T extends Decision>(
  decisions: readonly T[],
): T[] {
  const groups = new Map<string, T[]>();
  for (const q of decisions) {
    const key = humanDecisionGroupKey(q) ?? q.id;
    const group = groups.get(key) ?? [];
    group.push(q);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as T;
    if (group.length === 1) return first;
    return {
      ...first,
      question: `${first.question}（同卡同类共 ${group.length} 项，逐项处理）`,
      context: `${first.context}\n\n同卡同类待处理事项（当前按钮只回答 ${first.id}，其余事项保持未决）：\n${group
        .map(
          (q) =>
            `${q.id}｜来源 ${q.raised_by}｜${q.question}\n${q.context}\n选项：${q.options.map((o) => `${o.key}：${o.description}；影响：${o.impact}`).join("\n")}\n${q.kind === "approve" ? `审批版本：${JSON.stringify(q.target)}\n` : ""}状态：${q.status}`,
        )
        .join("\n\n")}`,
      // Keep full source objects for clients that support grouped rendering.
      grouped_decisions: group,
    };
  });
}
