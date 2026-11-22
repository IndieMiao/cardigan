import { redactSecrets } from "@cardigan/host";

/** Where a merge attempt stopped; shown verbatim in `merge_failed`. */
export type MergeFailureStage =
  | "选择基线分支"
  | "同步源仓库"
  | "读取基线"
  | "准备合并候选"
  | "发布合并"
  | "检查或结果记录";

/** Carries the stage that failed; the cause stays private to the host log. */
export class MergeStageError extends Error {
  constructor(
    readonly stage: MergeFailureStage,
    override readonly cause: unknown,
  ) {
    super(`${stage}失败`);
  }
}

/** Run one merge step and tag any failure with its stage (an inner tag wins). */
export async function mergeStage<T>(
  stage: MergeFailureStage,
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MergeStageError) throw error;
    throw new MergeStageError(stage, error);
  }
}

/**
 * One bounded line for a timeline: credentials redacted, absolute paths and
 * the argv line of a failed command dropped.
 */
export function redactMergeFailure(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "未知错误";
  const withoutArgv = raw.startsWith("Command failed:")
    ? raw.split(/\r?\n/u).slice(1).join("\n")
    : raw;
  const line =
    redactSecrets(withoutArgv)
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const clean = line
    .replace(/(?<=^|[\s'"`(=])(?:file:\/\/)?~?\/[^\s'"`,;:)]*/gu, "<路径>")
    .replace(/[\p{Cc}]/gu, "")
    .slice(0, 200);
  return clean || "未知错误";
}

/** `merge_failed` reason: which step failed and why, never raw paths or secrets. */
export function mergeFailureReason(
  card: string,
  error: unknown,
  fallback: MergeFailureStage = "准备合并候选",
): string {
  const stage = error instanceof MergeStageError ? error.stage : fallback;
  const cause = error instanceof MergeStageError ? error.cause : error;
  return `合并 ${card} 在「${stage}」环节失败：${redactMergeFailure(cause)}。未发布未经检查的代码`;
}
