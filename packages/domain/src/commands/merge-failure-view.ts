import type { Event } from "../entities.js";

/**
 * The latest recorded merge failure of one completion, or nothing. A failure
 * before any check was queued means the candidate itself could not be built.
 */
export function mergeFailureReason(
  events: readonly Event[],
  card_id: string,
  completion_id: string,
): string | undefined {
  const event = events.findLast(
    (e) =>
      e.card_id === card_id &&
      e.type === "merge_failed" &&
      (e.payload as { completion_id?: unknown } | null)?.completion_id ===
        completion_id,
  );
  const reason = (
    event?.payload as { result?: { reason?: unknown } } | null | undefined
  )?.result?.reason;
  return event
    ? typeof reason === "string"
      ? reason
      : "原因未记录"
    : undefined;
}

/** Why a completion has no merge check result yet. */
export function missingMergeCheckReason(
  gateEnabled: boolean | undefined,
  events: readonly Event[],
  card_id: string,
  completion_id: string,
): string {
  if (!gateEnabled) return "项目未配置合并闸门，须交人确认合并";
  const failure = mergeFailureReason(events, card_id, completion_id);
  return failure
    ? `合并候选准备失败，检查未排队：${failure.slice(0, 300)}`
    : "合并闸门检查尚未排队或尚无结果";
}
