/**
 * C-160 合并前核对项的界面文字。
 *
 * 状态：待人确认。全部新增文字集中在这里，人定稿后只改本文件；
 * 测试从这里取值，改文字不需要改测试。
 */
export const PRE_MERGE_COPY = {
  region: "合并前核对",
  status: { pending: "待完成", passed: "已通过", failed: "有问题" },
  waitingTitle: (labels: readonly string[]) =>
    `等待${labels.join("、")}，请先不要确认合并`,
  staleNote: "上次的结论针对旧版本，需要重新核对",
  missingHeading: "还差这些核对：",
  waitingHint:
    "核对全部通过后，这里会提示可以确认。你仍然可以直接确认合并，但会先请你再确认一次。",
  readyTitle: "核对已完成，可以确认合并",
  readySteps: (gate: boolean) => [
    "看一遍下面的“要合并的交付”和“审核与验收”。",
    "需要的话，在“补充说明”里写下你的原话。",
    "点“确认合并”。",
    gate
      ? "等待合并检查通过并完成合并，结果会出现在卡片时间线上。"
      : "合并结果会出现在卡片时间线上。",
  ],
  confirmTitle: (count: number) =>
    `还有 ${count} 项合并前核对没有完成，确定现在确认合并吗？`,
  confirmHint: "确认后会按你的拍板合并，不再等待这些核对。",
  confirmAnyway: "仍然确认合并",
  confirmCancel: "先不确认",
  eventLabel: "更新了合并前核对项",
} as const;
