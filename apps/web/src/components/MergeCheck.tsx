import type { MergeCheckView } from "../api.js";

const labels = {
  queued: "排队",
  running: "运行中",
  passed: "通过",
  failed: "失败",
  timed_out: "超时",
  interrupted: "中断",
} as const;

function duration(check: MergeCheckView | null, live: boolean): string {
  if (!check || check.status === "queued") return "尚未开始";
  if (check.status === "running" && !live) return "刚刚开始";
  const ms =
    check.status === "running"
      ? Date.now() - Date.parse(check.updated_at)
      : check.checks.length &&
          check.checks.some((c) => c.duration_ms !== undefined)
        ? check.checks.reduce((total, c) => total + (c.duration_ms ?? 0), 0)
        : Number.NaN;
  if (!Number.isFinite(ms)) return "未知";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function MergeCheck({
  check,
  projectId,
  live = false,
}: {
  readonly check: MergeCheckView | null;
  readonly projectId: string;
  readonly live?: boolean;
}) {
  const status = check?.status ?? "queued";
  const hasLog =
    check?.log_ref === `${check?.attempt_id}.log` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      check?.attempt_id ?? "",
    );
  return (
    <div className="merge-check">
      <div className="action-row">
        <span>合并检查</span>
        <span className={`status status-${status}`}>{labels[status]}</span>
        <span className="hint">用时：{duration(check, live)}</span>
        {hasLog && check && (
          <a
            href={`/api/projects/${encodeURIComponent(projectId)}/merge-checks/${encodeURIComponent(check.attempt_id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看日志
          </a>
        )}
      </div>
      {["failed", "timed_out", "interrupted"].includes(status) &&
        check?.summary && (
          <p className="merge-check-summary">{check.summary}</p>
        )}
    </div>
  );
}
