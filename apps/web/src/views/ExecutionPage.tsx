import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CardiganClient, ExecutionAssignment, RunView } from "../api.js";
import { Drawer } from "../components/Drawer.js";
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
  AttachCommands,
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
} from "../components/Operations.js";
import {
  assignmentActivity,
  type ExecutionSort,
  readExecutionSort,
  sortByActivity,
  writeExecutionSort,
} from "../execution-sort.js";
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
const runTime = (run: RunView) =>
  run.finished_at ?? run.started_at ?? run.queued_at;
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
function RunLine({ run }: { readonly run: RunView }) {
  return (
    <>
      <IdTag id={run.id} label={runKind(run)} />
      {run.queue_reason === "runtime_unavailable" ? (
        <span>等待运行环境恢复</span>
      ) : run.queue_ahead !== undefined ? (
        <span>排队中（前面还有 {run.queue_ahead} 个）</span>
      ) : (
        <StatusTag status={run.outcome ?? run.status} />
      )}
      {runTime(run) && <Time value={runTime(run)} />}
    </>
  );
}
function AssignmentRow({
  a,
  run,
  projectId,
  open,
  onOpen,
}: {
  readonly a: ExecutionAssignment;
  readonly run: RunView | undefined;
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpen: (trigger: HTMLElement) => void;
}) {
  const lastActivity = assignmentActivity(a, run);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <tr
      className={`execution-row${open ? " selected" : ""}`}
      onClick={() => {
        if (button.current) onOpen(button.current);
      }}
    >
      <td>
        <button
          ref={button}
          type="button"
          className="quiet execution-toggle"
          aria-haspopup="dialog"
          aria-label={`查看 ${a.id} 详情`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(event.currentTarget);
          }}
        >
          详情
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
            <RunLine run={run} />
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
  );
}

interface RunHistoryState {
  readonly runs: readonly RunView[];
  readonly total: number;
  readonly next: string | null;
}
/**
 * C-75: the drawer's Run history, read from the server ten at a time, newest
 * first. A live refresh re-reads the first page and keeps the older pages the
 * reader already loaded.
 */
function RunHistory({
  client,
  projectId,
  assignmentId,
  revision,
}: {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly revision: number;
}) {
  const [state, setState] = useState<RunHistoryState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the refresh signal.
  useEffect(() => {
    let cancelled = false;
    client.executionRuns(projectId, assignmentId).then(
      (page) => {
        if (cancelled) return;
        setError(undefined);
        setState((current) => {
          const last = page.runs.at(-1);
          const older =
            current === undefined || last === undefined
              ? []
              : current.runs.filter(
                  (run) =>
                    idNumber(run.id) < idNumber(last.id) &&
                    !page.runs.some((fresh) => fresh.id === run.id),
                );
          return {
            runs: [...page.runs, ...older],
            total: page.total,
            next:
              older.length > 0 && current
                ? current.next
                : (page.next_cursor ?? null),
          };
        });
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, projectId, assignmentId, revision]);
  const more = () => {
    if (!state?.next) return;
    setLoadingMore(true);
    client
      .executionRuns(projectId, assignmentId, state.next)
      .then(
        (page) => {
          setError(undefined);
          setState((current) =>
            current === undefined
              ? current
              : {
                  runs: [
                    ...current.runs,
                    ...page.runs.filter(
                      (run) => !current.runs.some((old) => old.id === run.id),
                    ),
                  ],
                  total: page.total,
                  next: page.next_cursor ?? null,
                },
          );
        },
        (reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoadingMore(false));
  };
  return (
    <section
      className="execution-drawer-section"
      aria-label={`${assignmentId} Run 历史`}
    >
      <h3>
        Run 历史
        {state && state.total > 0 && (
          <span className="hint">
            {" "}
            {state.runs.length} / {state.total}
          </span>
        )}
      </h3>
      {error && (
        <p role="alert" className="hint">
          读取 Run 历史失败：{error}
        </p>
      )}
      {state === undefined ? (
        !error && <p className="hint">正在读取 Run 历史…</p>
      ) : state.runs.length === 0 ? (
        <p className="hint">尚无 Run。</p>
      ) : (
        <>
          <ul className="execution-runs">
            {state.runs.map((entry) => (
              <li key={entry.id}>
                <div className="execution-run-head">
                  <RunLine run={entry} />
                </div>
                <RunSummary text={entry.summary} />
              </li>
            ))}
          </ul>
          {state.next && (
            <button
              type="button"
              className="quiet"
              disabled={loadingMore}
              onClick={more}
            >
              {loadingMore ? "正在读取…" : "显示更多"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
function idNumber(id: string): number {
  const digits = /(\d+)$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
}

const CURSOR_PAGE = 10;
/** C-75: ACK cursors fold into one line; expanded, newest seq first. */
function CursorList({ a }: { readonly a: ExecutionAssignment }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(CURSOR_PAGE);
  const cursors = [...a.cursors].sort(
    (left, right) => right.acked_seq - left.acked_seq,
  );
  const listId = useId();
  return (
    <section
      className="execution-drawer-section"
      aria-label={`${a.id} ACK 游标`}
    >
      <h3>ACK 游标</h3>
      {cursors.length === 0 ? (
        <p className="hint">尚无签收游标。</p>
      ) : (
        <>
          <button
            type="button"
            className="quiet execution-cursor-summary"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            已签收 {cursors.length} 张卡片，最新 seq{" "}
            {cursors[0]?.acked_seq ?? 0}
            <span aria-hidden="true">{open ? " ▴" : " ▾"}</span>
          </button>
          {open && (
            <>
              <ul id={listId} className="execution-runs">
                {cursors.slice(0, shown).map((cursor) => (
                  <li key={cursor.card_id}>
                    <IdTag id={cursor.card_id} label="卡片" />
                    <span>已签收 seq {cursor.acked_seq}</span>
                  </li>
                ))}
              </ul>
              {cursors.length > shown && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setShown(shown + CURSOR_PAGE)}
                >
                  显示更多
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ExecutionDetail({
  a,
  live,
  client,
  projectId,
  revision,
}: {
  readonly a: ExecutionAssignment;
  readonly live: boolean;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly revision: number;
}) {
  return (
    <div className="execution-drawer">
      <dl className="execution-basics">
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
      <div className="execution-actions">
        {a.status === "active" && a.runtime_ref && (
          <AttachCommands projectId={projectId} assignmentId={a.id} />
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
      <RunHistory
        client={client}
        projectId={projectId}
        assignmentId={a.id}
        revision={revision}
      />
      <CursorList key={a.id} a={a} />
    </div>
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
  // C-75: one detail drawer at a time; opening another row replaces it.
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const previousSelected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousSelected.current !== undefined && selected === undefined)
      lastTrigger.current?.focus();
    previousSelected.current = selected;
  }, [selected]);
  const open = (id: string, trigger: HTMLElement) => {
    lastTrigger.current = trigger;
    setSelected(id);
  };
  const view = filters.view ?? "working";
  const load = useCallback(
    () => client.execution(projectId),
    [client, projectId],
  );
  const { data, pending, error, reload, interactive } = useResource(
    load,
    revision,
  );
  const [sort, setSort] = useState<ExecutionSort>(() =>
    readExecutionSort(projectId),
  );
  useEffect(() => setSort(readExecutionSort(projectId)), [projectId]);
  const toggleSort = () => {
    const next: ExecutionSort = sort === "desc" ? "asc" : "desc";
    setSort(next);
    writeExecutionSort(projectId, next);
  };
  // Runs arrive newest first, so the first match is the Assignment's latest.
  const latestRun = (assignmentId: string) =>
    data?.runs.find((run) => run.assignment_id === assignmentId);
  const assignments = sortByActivity(
    (data?.assignments ?? []).filter((assignment) =>
      matchesView(assignment, view),
    ),
    (assignment) => assignmentActivity(assignment, latestRun(assignment.id)),
    sort,
  );
  const detail = data?.assignments.find((a) => a.id === selected);
  const detailLive =
    data?.runs.some(
      (run) => run.assignment_id === selected && unfinished(run),
    ) ?? false;
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
      <Feedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
      />
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
                  <th
                    scope="col"
                    aria-sort={sort === "desc" ? "descending" : "ascending"}
                  >
                    <button
                      type="button"
                      className="quiet execution-sort"
                      title={
                        sort === "desc"
                          ? "当前从新到旧，点击改为从旧到新"
                          : "当前从旧到新，点击改为从新到旧"
                      }
                      onClick={toggleSort}
                    >
                      最近活动
                      <span aria-hidden="true">
                        {sort === "desc" ? " ↓" : " ↑"}
                      </span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <AssignmentRow
                    key={assignment.id}
                    a={assignment}
                    run={latestRun(assignment.id)}
                    projectId={projectId}
                    open={assignment.id === selected}
                    onOpen={(trigger) => open(assignment.id, trigger)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <Drawer
        open={detail !== undefined}
        onOpenChange={(next) => {
          if (!next) setSelected(undefined);
        }}
        className="execution-drawer-content"
        title={detail ? `${detail.id} 详情` : "Assignment 详情"}
        description={
          detail
            ? `${detail.id}（${detail.role_id}）的运行环境、命令、Run 历史和 ACK 游标`
            : undefined
        }
      >
        {detail && (
          <ExecutionDetail
            key={detail.id}
            a={detail}
            live={detailLive}
            client={client}
            projectId={projectId}
            revision={revision}
          />
        )}
      </Drawer>
    </section>
  );
}
