/**
 * C-192 拍板建议（“按建议处理”）的界面文字。
 *
 * 状态：待 PM 按 Q-279 定稿。全部新增文字集中在这里，以后改文字只改本文件；
 * 测试从这里取值，改文字不需要改测试。
 */
export const SUGGESTION_COPY = {
  region: "建议",
  line: (option: string, rationale: string) =>
    `建议：${option}（${rationale}）`,
  apply: "按建议处理",
  stale: "已过期",
  staleHint:
    "交付、合并检查或合并前核对在建议之后有变化，请按当前情况自己选择。",
  returnReason: "退回原因（已按建议预填，可修改）",
  /** Merge confirmations name the option after the button the human knows. */
  mergeOptions: { merge: "确认合并", request_changes: "退回修改" } as Record<
    string,
    string
  >,
} as const;
