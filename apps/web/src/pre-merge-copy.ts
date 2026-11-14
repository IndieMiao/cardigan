/**
 * C-160 合并前核对项的界面文字。
 *
 * 状态：已定稿（Q-275）。全部新增文字集中在这里，以后改文字只改本文件；
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
    "请等所有前置条件满足后再确认；需要强行确认时，单独点“仍要合并”并填写理由。",
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
  // C-179：核对项通过后提醒仍在挡合并的人工待办。提醒正文按 Q-279 由 PM 定，
  // 在 domain 的 preMergeCheckReminderText；下面三处界面文字待 PM 确认。
  reminderEventLabel: "提醒处理挡合并的人工待办",
  reminderTag: "核对项已通过",
  reminderLink: "在卡片中查看",
} as const;
