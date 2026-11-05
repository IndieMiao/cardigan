import { useCallback } from "react";
import type { CardiganClient, ExecutionAssignment, RunView } from "../api.js";
import {
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
} from "../components/Operations.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";

const states: Record<string, string> = {
  active: "有效",
  suspended: "已暂停",
  released: "已释放",
  not_provisioned: "未启动",
  provisioning: "启动中",
  idle: "空闲",
  running: "运行中",
  unknown: "状态未知",
  lost: "失联",
  queued: "排队中",
  dispatched: "已派发",
  acked: "已签收",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const kinds: Record<string, string> = {
  initial: "首次执行",
  rework: "审核返工",
  decision_resumed: "拍板后恢复",
  followup: "后续执行",
  fix: "合并修复",
};
const unfinished = (run: RunView) =>
  !["completed", "failed", "cancelled"].includes(run.status);
function Assignment({
  a,
  runs,
  projectId,
}: {
  a: ExecutionAssignment;
  runs: readonly RunView[];
  projectId: string;
}) {
  // The API's full run list is newest first, including queued Runs without started_at.
  const run = runs.find((r) => r.assignment_id === a.id),
    live = runs.some((r) => r.assignment_id === a.id && unfinished(r));
  const color = ["lost", "unknown"].includes(a.runtime_state)
    ? "awaiting_merge"
    : a.runtime_state === "running"
      ? "in_progress"
      : "todo";
  return (
    <article className="needs-item" aria-label={`执行 ${a.id}`}>
      <header>
        <strong>
          {a.id} · {a.role_id} v{a.role_version}
          {a.standing_mode === "office"
            ? " · PM 前台"
            : a.standing_mode === "ops"
              ? " · PM 后台"
              : ""}
        </strong>{" "}
        <span className={`status status-${color}`}>
          {states[a.runtime_state] ?? a.runtime_state}
        </span>{" "}
        <span>{states[a.status] ?? a.status}</span>
      </header>
      <p>
        <CardLink projectId={projectId} id={a.card_id} /> ·{" "}
        {a.work_item_id ?? "常驻"} · 机器 {a.machine_id}
      </p>
      <dl>
        <dt>Session</dt>
        <dd>{a.session_ref ?? "尚无会话"}</dd>
        <dt>终端</dt>
        <dd>
          {a.runtime_ref
            ? `${a.runtime_ref.runtime_machine} / ${a.runtime_ref.terminal_ref}`
            : "未登记"}
        </dd>
        <dt>登记工作树</dt>
        <dd>{a.worktree_path ?? "不使用工作树"}</dd>
        <dt>分支</dt>
        <dd>{a.branch ?? "无"}</dd>
        <dt>最近 MCP 活动</dt>
        <dd>{a.last_mcp_activity_at ?? "尚无记录"}</dd>
      </dl>
      {run ? (
        <p>
          最近 Run：{run.id} · {kinds[run.kind] ?? run.kind} ·{" "}
          {states[run.status] ?? run.status} · {run.model} · Role v
          {run.role_version} · CLI {run.agent_cli_version}
        </p>
      ) : (
        <p>尚无 Run。</p>
      )}
      <details>
        <summary>Run 历史与 ACK 游标</summary>
        <ul>
          {runs
            .filter((r) => r.assignment_id === a.id)
            .map((r) => (
              <li key={r.id}>
                {r.id} · {states[r.status] ?? r.status} ·{" "}
                {r.summary || "无摘要"}
              </li>
            ))}
        </ul>
        {!a.cursors.length ? (
          <p>尚无签收游标。</p>
        ) : (
          <ul>
            {a.cursors.map((c) => (
              <li key={c.card_id}>
                {c.card_id} · 已签收 seq {c.acked_seq}
              </li>
            ))}
          </ul>
        )}
      </details>
      <div className="execution-actions">
        {a.status === "active" && a.runtime_ref && (
          <CopyCommand
            label="在 Herdr 中打开"
            command={cliCommand(projectId, "assignment attach", a.id)}
          />
        )}
        {a.status === "active" &&
          !live &&
          ["idle", "not_provisioned"].includes(a.runtime_state) &&
          !["done", "cancelled", "awaiting_merge"].includes(
            a.card_status ?? "",
          ) && (
            <CopyCommand
              label="启动或恢复会话"
              command={cliCommand(projectId, "assignment start", a.id)}
            />
          )}
        {a.status === "active" && a.runtime_ref && live && (
          <CopyCommand
            label="停止终端并取消当前 Run"
            command={cliCommand(projectId, "assignment stop", a.id)}
          />
        )}
        <CopyCommand
          label="查看收件箱"
          command={cliCommand(projectId, "inbox --assignment", a.id)}
        />
        {a.worktree_path && (
          <CopyCommand
            label="查看 Diff"
            command={cliCommand(projectId, "worktree diff", a.id)}
          />
        )}
        <CopyCommand
          label="检查异常"
          command={cliCommand(projectId, "attention")}
        />
        <a href={routeHash({ kind: "needs-you", projectId })}>
          处理拍板、清理或失联事项
        </a>
      </div>
    </article>
  );
}
export function ExecutionPage({
  client,
  projectId,
}: {
  client: CardiganClient;
  projectId: string;
}) {
  const load = useCallback(
    () => client.execution(projectId),
    [client, projectId],
  );
  const { data, pending, error, reload } = useResource(load);
  return (
    <section aria-label="执行视图">
      <div className="toolbar">
        <h1>执行视图</h1>
        <button type="button" className="quiet" onClick={reload}>
          刷新
        </button>
      </div>
      <Feedback pending={pending} error={error} retry={reload} />
      {data && (
        <>
          <p>
            {data.assignments.length} 个 Assignment ·{" "}
            {data.runs.filter(unfinished).length} 个未结束 Run
          </p>
          {!!data.machines.length && (
            <details>
              <summary>机器（{data.machines.length}）</summary>
              <ul>
                {data.machines.map((m) => (
                  <li key={m.id}>
                    {m.id} · {m.label} ·{" "}
                    {(
                      {
                        online: "在线",
                        offline: "离线",
                        draining: "停止接收新任务",
                      } as Record<string, string>
                    )[m.status] ?? m.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!data.assignments.length && (
            <p className="empty">还没有 Assignment。</p>
          )}
          {data.assignments.map((a) => (
            <Assignment
              key={a.id}
              a={a}
              runs={data.runs}
              projectId={projectId}
            />
          ))}
        </>
      )}
    </section>
  );
}
