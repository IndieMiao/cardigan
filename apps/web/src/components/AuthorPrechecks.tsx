import type { AuthorPrecheck } from "../api.js";
import { StatusTag } from "./Foundation.js";

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
}: {
  readonly checks: readonly AuthorPrecheck[];
}) {
  return (
    <section className="card-section author-prechecks" aria-label="作者预检查">
      <h2>作者预检查</h2>
      <p className="hint">
        结果仅适用于所列被检提交。通过后仍需正式审核和最终合并检查。
      </p>
      {!checks.length ? (
        <p className="hint">尚无作者预检查</p>
      ) : (
        <ul>
          {checks.map((c) => (
            <li key={c.attempt_id}>
              <div className="action-row">
                <StatusTag
                  status={
                    c.status === "environment_failed" ? "failed" : c.status
                  }
                  label={labels[c.status]}
                />
                <span>被检提交</span>
                <code title={c.head_sha}>{c.head_sha.slice(0, 12)}</code>
              </div>
              <p className="hint">当前版本适用性未核。</p>
              {c.summary && <p className="precheck-summary">{c.summary}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
