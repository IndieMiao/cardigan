import type { DeliveryPrecheck } from "../api.js";
import { StatusTag } from "./Foundation.js";

const labels: Record<DeliveryPrecheck["status"], string> = {
  queued: "排队等待",
  running: "运行中",
  passed: "预检查通过",
  failed: "测试失败",
  timed_out: "超时，等待重查",
  interrupted: "执行中断",
  executor_unreachable: "执行器不可达，等待重试",
  environment_failed: "检查环境未就绪",
};
export function DeliveryPrechecks({
  checks,
  projectId,
}: {
  checks: readonly DeliveryPrecheck[];
  projectId: string;
}) {
  return (
    <section
      className="card-section delivery-prechecks"
      aria-label="交付预检查"
    >
      <h2>交付预检查</h2>
      <p className="hint">
        独立复核前的检查。通过后仍需正式复核和最终合并检查；新交付不沿用旧结果。
      </p>
      {!checks.length && <p>尚无交付预检查</p>}
      {checks.map((check) => (
        <div className="merge-check" key={check.delivery_id}>
          <div className="action-row">
            <span>{check.delivery_id}</span>
            <StatusTag
              status={
                check.status === "environment_failed" ? "failed" : check.status
              }
              label={labels[check.status]}
            />
            {check.attempt_id &&
              check.log_ref === `${check.attempt_id}.log` &&
              /^[0-9a-f-]{36}$/u.test(check.attempt_id) && (
                <a
                  href={`/api/projects/${encodeURIComponent(projectId)}/merge-checks/${encodeURIComponent(check.attempt_id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看预检查日志
                </a>
              )}
          </div>
          {check.summary && (
            <p
              className={
                check.status === "failed"
                  ? "merge-check-summary"
                  : "delivery-precheck-summary"
              }
            >
              {check.summary}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
