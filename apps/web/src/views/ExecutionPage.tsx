import { useCallback } from "react";
import type { CardiganClient, ExecutionAssignment, RunView } from "../api.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import {
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
} from "../components/Operations.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";

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
  return (
    <article className="needs-item" aria-label={`执行 ${a.id}`}>
      <header>
        <IdTag
          id={a.id}
          label={a.role_id}
          detail={`${a.role_id} v${a.role_version}`}
        />
        <span>
          {a.standing_mode === "office"
            ? "PM 前台"
            : a.standing_mode === "ops"
              ? "PM 后台"
              : ""}
        </span>
        <StatusTag status={a.runtime_state} /> <StatusTag status={a.status} />
      </header>
      <p className="metadata">
        <CardLink projectId={projectId} id={a.card_id} />
        {a.work_item_id ? (
          <IdTag id={a.work_item_id} label="工作项" />
        ) : (
          <span>常驻</span>
        )}
        <span>机器：{a.machine_id}</span>
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
        <dd>
          {a.last_mcp_activity_at ? (
            <Time value={a.last_mcp_activity_at} />
          ) : (
            "尚无记录"
          )}
        </dd>
      </dl>
      {run ? (
        <p className="metadata">
          <span>
            最近 Run：
            <IdTag id={run.id} label={kinds[run.kind] ?? "执行"} />
          </span>
          <StatusTag status={run.status} />
          <span>模型：{run.model}</span>
          <span>角色版本：{run.role_version}</span>
          <span>CLI 版本：{run.agent_cli_version}</span>
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
                <IdTag id={r.id} label={kinds[r.kind] ?? "执行"} />{" "}
                <StatusTag status={r.status} />{" "}
                <span>{r.summary || "无摘要"}</span>
              </li>
            ))}
        </ul>
        {!a.cursors.length ? (
          <p>尚无签收游标。</p>
        ) : (
          <ul>
            {a.cursors.map((c) => (
              <li key={c.card_id}>
                <IdTag id={c.card_id} label="卡片" />{" "}
                <span>已签收 seq {c.acked_seq}</span>
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
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const load = useCallback(
    () => client.execution(projectId),
    [client, projectId],
  );
  const { data, pending, error, reload } = useResource(load, revision);
  return (
    <section aria-label="执行视图">
      <PageTitle
        title="执行视图"
        description="查看 Agent 的运行环境、最近执行和可用命令。"
      />
      <Feedback pending={pending} error={error} retry={reload} />
      {data && (
        <>
          <p>
            {data.assignments.length} 个 Assignment，
            {data.runs.filter(unfinished).length} 个未结束 Run
          </p>
          {!!data.machines.length && (
            <details>
              <summary>机器（{data.machines.length}）</summary>
              <ul>
                {data.machines.map((m) => (
                  <li key={m.id}>
                    <IdTag id={m.id} label={m.label} />{" "}
                    <StatusTag status={m.status} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!data.assignments.length && (
            <EmptyState>
              还没有 Assignment。指派工作后会在这里显示运行情况。
            </EmptyState>
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
