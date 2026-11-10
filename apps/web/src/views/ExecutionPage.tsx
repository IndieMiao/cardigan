import { useCallback, useState } from "react";
import type { CardiganClient, ExecutionAssignment, RunView } from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { FilterBar } from "../components/FilterBar.js";
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
import { routeHash, useRouteFilters } from "../route.js";
import { useResource } from "../useResource.js";

const kinds: Readonly<Record<string, string>> = {
  initial: "首次执行",
  rework: "审核返工",
  decision_resumed: "拍板后恢复",
  followup: "后续执行",
  fix: "合并修复",
};
const unfinished = (run: RunView) =>
  !["completed", "failed", "cancelled"].includes(run.status);
const runKind = (run: RunView) => kinds[run.kind] ?? "执行";
const runTime = (run: RunView) => run.finished_at ?? run.started_at;
const working = (a: ExecutionAssignment) =>
  a.status === "active" &&
  (a.queue_ahead !== undefined ||
    (a.runtime_ref !== null && !["lost", "unknown"].includes(a.runtime_state)));
const lost = (a: ExecutionAssignment) =>
  ["lost", "unknown"].includes(a.runtime_state);
const viewLabel: Readonly<Record<string, string>> = {
  working: "工作中",
  all: "全部",
  released: "已释放",
  lost: "失联",
};
function matchesView(a: ExecutionAssignment, view: string): boolean {
  if (view === "all") return true;
  if (view === "released") return a.status === "released";
  if (view === "lost") return lost(a);
  return working(a);
}
function RunSummary({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  if (text.trim().length === 0) return <span className="hint">无摘要</span>;
  return (
    <div className={`execution-summary${open ? " open" : ""}`}>
      <p>{text}</p>
      {text.length > 60 && (
        <button
          type="button"
          className="quiet"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "收起摘要" : "展开摘要"}
        </button>
      )}
    </div>
  );
}
function AssignmentRow({
  a,
  runs,
  projectId,
  expanded,
  toggle,
}: {
  readonly a: ExecutionAssignment;
  readonly runs: readonly RunView[];
  readonly projectId: string;
  readonly expanded: boolean;
  readonly toggle: () => void;
}) {
  const assignmentsRuns = runs.filter((run) => run.assignment_id === a.id),
    run = assignmentsRuns[0],
    live = assignmentsRuns.some(unfinished),
    lastActivity = a.last_mcp_activity_at ?? (run ? runTime(run) : undefined),
    [showAllRuns, setShowAllRuns] = useState(false);
  return (
    <>
      <tr className="execution-row" onClick={toggle} aria-expanded={expanded}>
        <td>
          <button
            type="button"
            className="quiet execution-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${a.id} 详情`}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            {expanded ? "收起" : "展开"}
          </button>
          <EmployeeIdentity {...a} author_role={a.role_id} />
          <IdTag
            id={a.id}
            label={a.role_id}
            detail={`${a.role_id} v${a.role_version}`}
          />
          {a.standing_mode && (
            <span className="hint">
              {a.standing_mode === "office" ? "PM 前台" : "PM 后台"}
            </span>
          )}
        </td>
        <td>
          {a.work_item_id ? (
            <>
              <CardLink projectId={projectId} id={a.card_id} />
              <IdTag id={a.work_item_id} label="工作项" />
            </>
          ) : (
            <span>常驻 PM（项目级）</span>
          )}
        </td>
        <td>
          <dl className="execution-status">
            <dt>运行</dt>
            <dd>
              <StatusTag status={a.runtime_state} />
            </dd>
            <dt>Assignment</dt>
            <dd>
              <StatusTag status={a.status} subdued={a.status === "active"} />
            </dd>
          </dl>
        </td>
        <td>
          {run ? (
            <span className="execution-run">
              <IdTag id={run.id} label={runKind(run)} />
              {run.queue_ahead !== undefined ? (
                <span>排队中（前面还有 {run.queue_ahead} 个）</span>
              ) : (
                <StatusTag status={run.outcome ?? run.status} />
              )}
              {runTime(run) && <Time value={runTime(run)} />}
            </span>
          ) : (
            <span className="hint">尚无 Run</span>
          )}
        </td>
        <td>
          {lastActivity ? (
            <Time value={lastActivity} />
          ) : (
            <span className="hint">尚无记录</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="execution-detail">
          <td colSpan={5}>
            <div className="execution-detail-grid">
              <dl>
                <dt>Session</dt>
                <dd>{a.session_ref ?? "尚无会话"}</dd>
                <dt>终端</dt>
                <dd>
                  {a.runtime_ref
                    ? `${a.runtime_ref.runtime_machine} / ${a.runtime_ref.terminal_ref}`
                    : "未登记"}
                </dd>
                <dt>Worktree</dt>
                <dd>{a.worktree_path ?? "不使用工作树"}</dd>
                <dt>分支</dt>
                <dd>{a.branch ?? "无"}</dd>
                <dt>机器</dt>
                <dd>{a.machine_id}</dd>
              </dl>
              <section aria-label={`${a.id} Run 历史`}>
                <h3>Run 历史</h3>
                {assignmentsRuns.length === 0 ? (
                  <p className="hint">尚无 Run。</p>
                ) : (
                  <>
                    <ul className="execution-runs">
                      {(showAllRuns
                        ? assignmentsRuns
                        : assignmentsRuns.slice(0, 5)
                      ).map((entry) => (
                        <li key={entry.id}>
                          <div className="execution-run-head">
                            <IdTag id={entry.id} label={runKind(entry)} />
                            {entry.queue_ahead !== undefined ? (
                              <span>
                                排队中（前面还有 {entry.queue_ahead} 个）
                              </span>
                            ) : (
                              <StatusTag
                                status={entry.outcome ?? entry.status}
                              />
                            )}
                            {runTime(entry) && <Time value={runTime(entry)} />}
                          </div>
                          <RunSummary text={entry.summary} />
                        </li>
                      ))}
                    </ul>
                    {assignmentsRuns.length > 5 && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setShowAllRuns(!showAllRuns)}
                      >
                        {showAllRuns
                          ? "只显示最近 5 条"
                          : `显示全部 ${assignmentsRuns.length} 条`}
                      </button>
                    )}
                  </>
                )}
                <h3>ACK 游标</h3>
                {a.cursors.length === 0 ? (
                  <p className="hint">尚无签收游标。</p>
                ) : (
                  <ul className="execution-runs">
                    {a.cursors.map((cursor) => (
                      <li key={cursor.card_id}>
                        <IdTag id={cursor.card_id} label="卡片" />
                        <span>已签收 seq {cursor.acked_seq}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
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
          </td>
        </tr>
      )}
    </>
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
  const [filters, setFilters] = useRouteFilters({
    kind: "execution",
    projectId,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const view = filters.view ?? "working";
  const load = useCallback(
    () => client.execution(projectId),
    [client, projectId],
  );
  const { data, pending, error, reload } = useResource(load, revision);
  const assignments = (data?.assignments ?? []).filter((assignment) =>
    matchesView(assignment, view),
  );
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section aria-label="执行视图" className="execution-page">
      <PageTitle
        title="执行视图"
        description="查看 Agent 的运行环境、最近执行和可用命令。"
      />
      <FilterBar
        fields={[
          {
            key: "view",
            label: "筛选",
            options: Object.entries(viewLabel).map(([value, label]) => ({
              value,
              label,
            })),
          },
        ]}
        values={{ ...filters, view }}
        onChange={setFilters}
      />
      <Feedback pending={pending} error={error} retry={reload} />
      {data && (
        <>
          <p className="metadata">
            <span>
              显示 {assignments.length} / {data.assignments.length} 个
              Assignment
            </span>
            <span>{data.runs.filter(unfinished).length} 个未结束 Run</span>
          </p>
          {!!data.machines.length && (
            <details>
              <summary>机器（{data.machines.length}）</summary>
              <ul>
                {data.machines.map((machine) => (
                  <li key={machine.id}>
                    <IdTag id={machine.id} label={machine.label} />{" "}
                    <StatusTag status={machine.status} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {assignments.length === 0 ? (
            <EmptyState>
              {view === "working"
                ? "现在没有工作中的 Assignment。切换筛选可查看全部、已释放或失联的 Assignment。"
                : `没有符合条件的 Assignment（${viewLabel[view] ?? view}）。`}
            </EmptyState>
          ) : (
            <table className="execution-table">
              <thead>
                <tr>
                  <th scope="col">Assignment</th>
                  <th scope="col">卡片和工作项</th>
                  <th scope="col">运行状态</th>
                  <th scope="col">最近 Run</th>
                  <th scope="col">最近活动</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <AssignmentRow
                    key={assignment.id}
                    a={assignment}
                    runs={data.runs}
                    projectId={projectId}
                    expanded={expanded.has(assignment.id)}
                    toggle={() => toggle(assignment.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
