import type { MergeCheckBlocker } from "../api.js";
import { fullTime } from "./Foundation.js";

export function mergeBlockerMessage(blocker: MergeCheckBlocker): string {
  const since = new Date(blocker.started_at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `合并检查未开始：被 ${blocker.label} 挡住（自 ${since} 起）：${blocker.detail}`;
}

export function MergeBlockers({
  blockers,
}: {
  readonly blockers: readonly MergeCheckBlocker[];
}) {
  return (
    <>
      {blockers.map((blocker) => (
        <p key={blocker.key} title={fullTime(blocker.started_at)}>
          {mergeBlockerMessage(blocker)}
        </p>
      ))}
    </>
  );
}
