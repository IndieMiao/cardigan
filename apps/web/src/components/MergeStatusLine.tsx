import type { NeedsDecision } from "../api.js";
import { fullTime, StatusTag } from "./Foundation.js";

function Deadline({ value }: { readonly value: string }) {
  return (
    <time dateTime={value} title={fullTime(value)}>
      {new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })}
    </time>
  );
}

/** Display only: ownership, snooze and check facts come from the read model. */
export function MergeStatusFacts({
  q,
  elapsed = 0,
}: {
  readonly q: NeedsDecision;
  readonly elapsed?: number;
}) {
  const merge = q.merge_confirmation;
  const check = merge?.merge_check;
  const confirmed = q.status === "resolved";
  const pm = q.decider === "role:pm" && !confirmed;
  const snoozed = q.status === "snoozed";
  const waitingForHost =
    !merge?.merge_noop &&
    merge?.merge_gate_enabled &&
    ["interrupted", "executor_unreachable"].includes(check?.status ?? "");
  const failed =
    !merge?.merge_noop &&
    merge?.merge_gate_enabled &&
    ["failed", "timed_out"].includes(check?.status ?? "");
  const checkLabel = merge?.merge_gate_invalid
    ? "配置无效"
    : merge?.merge_noop
      ? "无需检查"
      : !merge
        ? "资料未提供"
        : !merge.merge_gate_enabled
          ? "未启用"
          : null;
  return (
    <>
      <span className="decision-blocking">
        ◇ {q.blocking && !q.followup_notice ? "阻塞后续" : "非阻塞"}
      </span>
      {snoozed && (
        <span className="decision-wait">
          {q.snooze ? (
            <>
              已暂缓至 <Deadline value={q.snooze.until} />
            </>
          ) : (
            "暂缓中（到期时间未知）"
          )}
        </span>
      )}
      <StatusTag
        status={pm || snoozed ? "snoozed" : "open"}
        label={
          pm
            ? snoozed
              ? "PM 暂缓中"
              : "PM 代确认中"
            : merge?.merge_gate_invalid
              ? "等主机处理"
              : waitingForHost
                ? "等主机恢复"
                : failed || confirmed
                  ? "等你处理"
                  : "等你确认"
        }
      />
      {pm && <span>你可直接处理</span>}
      {confirmed && <span>已确认合并</span>}
      {!confirmed && (
        <span>{merge?.blockers?.length === 0 ? "检查都已通过" : "等待中"}</span>
      )}
      <span className="decision-check">
        合并检查：
        {checkLabel ?? <StatusTag status={check?.status ?? "queued"} />}
      </span>
      {q.auto_merge && (
        <span>
          自动合并：
          <Deadline value={q.auto_merge.due_at} />
          （偏好设置：{q.auto_merge.minutes} 分钟）
          {q.auto_merge.remaining_ms !== undefined
            ? ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.remaining_ms - elapsed) / 60_000))} 分钟`
            : q.waited_ms !== null &&
              ` · 剩余 ${Math.max(0, Math.ceil((q.auto_merge.minutes * 60_000 - q.waited_ms - elapsed) / 60_000))} 分钟`}
        </span>
      )}
    </>
  );
}

export function MergeStatusLine({
  q,
  elapsed,
}: {
  readonly q: NeedsDecision;
  readonly elapsed: number;
}) {
  return (
    <section className="decision-status-line" aria-label={`${q.id} 状态`}>
      <MergeStatusFacts q={q} elapsed={elapsed} />
    </section>
  );
}
