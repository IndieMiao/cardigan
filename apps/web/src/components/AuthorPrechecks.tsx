import type { AuthorPrecheck } from "../api.js";
import { StatusTag, Time } from "./Foundation.js";

const labels: Record<AuthorPrecheck["status"], string> = {
  queued: "排队中",
  running: "运行中",
  passed: "所列提交预检查通过",
  failed: "预检查失败",
  timed_out: "超时",
  interrupted: "已中断",
  executor_unreachable: "执行器不可达",
  environment_failed: "环境故障",
};
export function AuthorPrechecks({
  checks,
  projectId,
}: {
  readonly checks: readonly AuthorPrecheck[];
  readonly projectId: string;
}) {
  if (!checks.length) return null;
  return (
    <section className="author-prechecks" aria-label="作者预检查">
      <ul>
        {checks.map((check) => (
          <li
            key={check.attempt_id}
            title={check.summary}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: narrow check rows support keyboard scrolling.
            tabIndex={0}
          >
            <StatusTag
              status={
                check.status === "environment_failed" ? "failed" : check.status
              }
              label={labels[check.status]}
            />
            <code title={`被检提交 ${check.head_sha}`}>
              {check.head_sha.slice(0, 7)}
            </code>
            {check.updated_at && <Time value={check.updated_at} />}
            {check.log_ref === `${check.attempt_id}.log` &&
              /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(check.attempt_id) && (
                <a
                  href={`/api/projects/${encodeURIComponent(projectId)}/prechecks/${encodeURIComponent(check.attempt_id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看日志
                </a>
              )}
          </li>
        ))}
      </ul>
    </section>
  );
}
