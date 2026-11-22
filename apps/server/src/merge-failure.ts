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
 * One bounded line for a timeline: credentials, paths (quoted ones whole),
 * URLs, hosts and IP addresses redacted; the argv line of a failed command
 * dropped.
 */
export function redactMergeFailure(error: unknown): string {
  // A system (file-system or process) error names a path whose quoting
  // cannot be trusted: keep only the error code and the operation.
  const system = error as { code?: unknown; syscall?: unknown } | null;
  if (
    error instanceof Error &&
    typeof system?.code === "string" &&
    /^E[A-Z0-9]+$/u.test(system.code) &&
    typeof system.syscall === "string" &&
    /^[a-z_]+$/u.test(system.syscall)
  )
    return `${system.code}（${system.syscall}）`;
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
    // A quoted absolute path may itself contain quotes or spaces: redact up
    // to the last matching quote of the line rather than guess its end.
    .replace(/'(?:file:\/\/|~?\/).*'/gu, "'<路径>'")
    .replace(/"(?:file:\/\/|~?\/).*"/gu, '"<路径>"')
    .replace(/`(?:file:\/\/|~?\/).*`/gu, "`<路径>`")
    // Other quotations naming a path or address are replaced whole. Plain
    // ref names stay readable.
    .replace(/(['"`])([^'"`]*)\1/gu, (whole, quote: string, body: string) =>
      /^refs\/[\w./-]+$/u.test(body) || !/[/\\@]|:\/\//u.test(body)
        ? whole
        : `${quote}<路径>${quote}`,
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/giu, "<地址>")
    .replace(/\b[\w.-]+@[\w.-]+:[^\s'"`]*/gu, "<地址>")
    .replace(/(?<=^|[\s'"`(=])~?\/[^\s'"`,;:)]*/gu, "<路径>")
    .replace(/\b(host(?:name)?)\s+[^\s'"`,;:]+/giu, "$1 <主机>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, "<地址>")
    .replace(
      /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|(?<![\w:])::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*/giu,
      "<地址>",
    )
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
