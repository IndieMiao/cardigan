import { useEffect, useId, useState } from "react";
import type {
  CardiganClient,
  ExecutionAssignment,
  ExecutionRunPage,
  RunView,
} from "../api.js";
import { routeHash } from "../route.js";
import {
  AssignmentMachine,
  type ContextLevel,
  contextReading,
  contextUsage,
  MaintenanceReason,
  RunLine,
  RunSummary,
  runHarness,
  runModelEffort,
} from "./ExecutionContent.js";
import { IdTag, StatusTag, Time } from "./Foundation.js";
import { CardDetailLayout } from "./layout/CardDetailLayout.js";
import { AttachCommands, CopyCommand, cliCommand } from "./Operations.js";
import { Button } from "./ui/button.js";

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
        setState((current) => mergeFirstPage(current, page));
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
    const before = state?.next;
    if (!before) return;
    setLoadingMore(true);
    client
      .executionRuns(projectId, assignmentId, before)
      .then(
        (page) => {
          setError(undefined);
          // The page continues the chain it was asked for only if the list
          // still ends at that cursor. A refresh that restarted from a new
          // first page meanwhile makes this response stale: appending it
          // would skip the Runs in between, so it is dropped and the new
          // chain's own 显示更多 reads them.
          setState((current) =>
            current === undefined ||
            current.next !== before ||
            current.runs.at(-1)?.id !== before
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
      className="execution-drawer-section card-section"
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
          <ul className="execution-runs board-list">
            {state.runs.map((entry) => (
              <li key={entry.id}>
                <div className="execution-run-head metadata">
                  <RunLine run={entry} />
                </div>
                <RunSummary text={entry.summary} />
              </li>
            ))}
          </ul>
          {state.next && (
            <Button
              type="button"
              className="quiet"
              disabled={loadingMore}
              onClick={more}
            >
              {loadingMore ? "正在读取…" : "显示更多"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
/**
 * Merge a re-read first page into the pages already loaded. The older pages
 * are kept only when they continue the new first page without a gap, i.e. the
 * new page's last Run is one the reader already has; the loaded Runs after it
 * are then contiguous server pages. Otherwise (more new Runs than one page)
 * the list restarts from the new first page so "显示更多" reads the rest in
 * order instead of skipping the Runs in between.
 */
function mergeFirstPage(
  current: RunHistoryState | undefined,
  page: ExecutionRunPage,
): RunHistoryState {
  const fresh: RunHistoryState = {
    runs: page.runs,
    total: page.total,
    next: page.next_cursor ?? null,
  };
  const last = page.runs.at(-1);
  if (current === undefined || last === undefined || fresh.next === null)
    return fresh;
  const join = current.runs.findIndex((run) => run.id === last.id);
  if (join < 0) return fresh;
  const older = current.runs.slice(join + 1);
  return older.length === 0
    ? fresh
    : { runs: [...page.runs, ...older], total: page.total, next: current.next };
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
      className="execution-drawer-section card-section"
      aria-label={`${a.id} ACK 游标`}
    >
      <h3>ACK 游标</h3>
      {cursors.length === 0 ? (
        <p className="hint">尚无签收游标。</p>
      ) : (
        <>
          <Button
            type="button"
            className="quiet execution-cursor-summary"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            已签收 {cursors.length} 张卡片，最新 seq{" "}
            {cursors[0]?.acked_seq ?? 0}
            <span aria-hidden="true">{open ? " ▴" : " ▾"}</span>
          </Button>
          {open && (
            <>
              <ul id={listId} className="execution-runs board-list">
                {cursors.slice(0, shown).map((cursor) => (
                  <li key={cursor.card_id}>
                    <IdTag id={cursor.card_id} label="卡片" />
                    <span>已签收 seq {cursor.acked_seq}</span>
                  </li>
                ))}
              </ul>
              {cursors.length > shown && (
                <Button
                  type="button"
                  className="quiet"
                  onClick={() => setShown(shown + CURSOR_PAGE)}
                >
                  显示更多
                </Button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function ExecutionDetail({
  a,
  run,
  live,
  client,
  projectId,
  revision,
}: {
  readonly a: ExecutionAssignment;
  readonly run: RunView | undefined;
  readonly live: boolean;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly revision: number;
}) {
  return (
    <CardDetailLayout className="execution-drawer card-page-drawer">
      <div className="board-list">
        <dl className="execution-basics decision-record-detail">
          <dt>Assignment</dt>
          <dd>
            <StatusTag status={a.status} />
          </dd>
          <dt>Harness</dt>
          <dd>{runHarness(run)}</dd>
          <dt>模型 / effort</dt>
          <dd>{runModelEffort(run)}</dd>
          <dt>上下文</dt>
          <dd>
            {contextUsage(run)}
            {(() => {
              const reading = contextReading(run);
              return reading ? (
                <span className="hint">
                  {" "}
                  {reading.usedTokens.toLocaleString("en-US")} /{" "}
                  {reading.windowTokens.toLocaleString("en-US")} tokens，
                  {contextLevelLabel[reading.level]}
                </span>
              ) : null;
            })()}
          </dd>
          <dt>Session</dt>
          <dd>{a.session_ref ?? "尚无会话"}</dd>
          <dt>终端</dt>
          <dd>{a.runtime_ref?.terminal_ref ?? "未登记"}</dd>
          <dt>Worktree</dt>
          <dd>{a.worktree_path ?? "不使用工作树"}</dd>
          <dt>分支</dt>
          <dd>{a.branch ?? "无"}</dd>
          <dt>机器</dt>
          <dd>
            <AssignmentMachine a={a} plain />
          </dd>
          {a.session_maintenance && (
            <>
              <dt>会话维护</dt>
              <dd>
                <MaintenanceReason a={a} projectId={projectId} detail />
                {a.session_maintenance.candidate && <span>空闲候选</span>}
              </dd>
              <dt>最近评估</dt>
              <dd>
                <Time value={a.session_maintenance.evaluated_at} />
              </dd>
              <dt>候选阈值</dt>
              <dd>{a.session_maintenance.threshold_minutes} 分钟</dd>
            </>
          )}
        </dl>
        <div className="execution-actions board-list">
          {a.external ? (
            <p className="hint">外接身份，没有可接入的终端</p>
          ) : a.status === "active" && a.runtime_ref ? (
            <AttachCommands projectId={projectId} assignmentId={a.id} />
          ) : null}
          {!a.external &&
            a.status === "active" &&
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
          {!a.external && a.status === "active" && a.runtime_ref && live && (
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
    </CardDetailLayout>
  );
}

const contextLevelLabel: Readonly<Record<ContextLevel, string>> = {
  normal: "用量正常",
  handoff: "提醒",
  restart: "换会话",
};
