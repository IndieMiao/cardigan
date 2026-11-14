/** Q-458: one shared limit for the browser, HTTP writes and local CLI. */
export const MERGE_OVERRIDE_REASON_MAX_CODE_POINTS = 500;

export function mergeOverrideReasonError(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (!trimmed) return "强行合并理由 is required";
  // Count code points, not UTF-16 units or grapheme clusters; never truncate.
  if ([...trimmed].length > MERGE_OVERRIDE_REASON_MAX_CODE_POINTS)
    return `理由最多${MERGE_OVERRIDE_REASON_MAX_CODE_POINTS}个字符，请缩短后再提交。`;
  return undefined;
}
