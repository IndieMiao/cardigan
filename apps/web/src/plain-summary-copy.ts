/**
 * C-202 拍板“人话概述”的界面文字。全部新增文字集中在这里，以后改文字只改本文件；
 * 测试从这里取值，改文字不需要改测试。
 */
export const PLAIN_SUMMARY_COPY = {
  region: "人话概述",
  changed: "改了什么",
  impact: "对你的影响",
  risk: "风险",
  /** Shown next to a risk other than "无". */
  riskFlag: "请留意",
  /** The original context, folded below the plain summary. */
  details: "详细信息",
} as const;

/** True when the risk says there is none ("无"); mirrors the domain rule. */
export const noRisk = (risk: string) => /^无[。.！!]?$/u.test(risk.trim());
