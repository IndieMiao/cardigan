import { useEffect, useState } from "react";
import type { MergeCheckView } from "../api.js";
import { StatusTag } from "./Foundation.js";

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
  detailsOnly = false,
}: {
  readonly check: MergeCheckView | null;
  readonly projectId: string;
  readonly live?: boolean;
  /** The enclosing summary already shows status and failures. */
  readonly detailsOnly?: boolean;
}) {
  const status = check?.status ?? "queued";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live || status !== "queued") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, status]);
  const queuedAt = Date.parse(
    check?.queue_wait?.queued_at ?? check?.updated_at ?? "",
  );
  const waited = Math.max(
    0,
    Math.floor(
      ((live ? now : Date.parse(check?.updated_at ?? "")) - queuedAt) / 1000,
    ),
  );
  const hasLog =
    check?.log_ref === `${check?.attempt_id}.log` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      check?.attempt_id ?? "",
    );
  return (
    <section className="merge-check" aria-label="合并检查">
      <div className="action-row">
        <span>合并检查</span>
        {!detailsOnly && <StatusTag status={status} />}
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
      {check?.status === "queued" && (
        <p className="hint">
          {check.queue_wait?.reason ?? "等待主机调度检查"}
          {Number.isFinite(waited) &&
            ` · 已等待 ${Math.floor(waited / 60)} 分 ${waited % 60} 秒`}
        </p>
      )}
      {check?.executor && (
        <p className="hint">
          执行目标：{check.executor.name} ·{" "}
          {check.executor.type === "github"
            ? "GitHub · 同项目可并行"
            : "SSH · 每项目一个检查"}
        </p>
      )}
      {check?.base_sha && (
        <p className="hint">
          检查基线：
          <code title={check.base_sha}>{check.base_sha.slice(0, 12)}</code>
          。基线前进后须重新检查，通过不代表已合并。
        </p>
      )}
      {check?.scope && (
        <p className="hint">
          检查范围：
          {check.scope.kind === "docs_only"
            ? "仅文档"
            : check.scope.kind === "full"
              ? "全量"
              : "受影响包"}
          {check.scope.kind === "affected" && check.scope.packages?.length
            ? `（${check.scope.packages.join("、")}）`
            : ""}
        </p>
      )}
      {!!check?.checks.length && (
        <ul className="merge-check-items" aria-label="单项检查">
          {check.checks.map((item) => (
            <li key={item.name}>
              <span>{item.name}</span>
              <StatusTag status={item.status} />
              {item.status === "skipped" && item.reason === "card_tier" && (
                <span>仅批次执行</span>
              )}
              {item.status === "skipped" && item.reason === "docs_only" && (
                <span className="hint">仅文档变更</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!detailsOnly &&
        ["failed", "timed_out", "interrupted"].includes(status) &&
        check?.summary && (
          <p className="merge-check-summary">{check.summary}</p>
        )}
    </section>
  );
}
