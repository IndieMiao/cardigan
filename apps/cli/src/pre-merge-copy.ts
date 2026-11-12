import { PRE_MERGE_CHECK_STATUS_LABELS } from "@cardigan/domain";

/**
 * C-160 合并前核对项的命令行文字。
 *
 * 与 Workbench（apps/web/src/pre-merge-copy.ts，Q-275 已定稿）的说法一致；
 * 标“待人确认”的几条是命令行新增的，人定稿后只改本文件。
 */
export const CLI_PRE_MERGE_COPY = {
  status: PRE_MERGE_CHECK_STATUS_LABELS,
  waitingTitle: (labels: readonly string[]) =>
    `等待${labels.join("、")}，请先不要确认合并`,
  readyTitle: "核对已完成，可以确认合并",
  staleNote: "上次的结论针对旧版本，需要重新核对",
  confirmTitle: (count: number) =>
    `还有 ${count} 项合并前核对没有完成，确定现在确认合并吗？`,
  confirmHint: "确认后会按你的拍板合并，不再等待这些核对。",
  /** 待人确认（命令行新增）。 */
  statusHeading: "合并前核对：",
  /** 待人确认（命令行新增）。 */
  confirmNeedsYes: (command: string) =>
    `仍要确认合并，请加 --yes 重新运行：${command} --yes`,
  /** 待人确认（命令行新增）。 */
  confirmedAnyway: (count: number) =>
    `注意：还有 ${count} 项合并前核对没有完成，已按你的 --yes 确认合并。`,
} as const;
