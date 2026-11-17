import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  CardiganClient,
  ExecutionAssignment,
  ExecutionRunPage,
  RunView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { ExecutionDiagnostics } from "../components/ExecutionDiagnostics.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import { IdentityRow } from "../components/IdentityRow.js";
import { IdBadge } from "../components/IdTag.js";
import {
  AttachCommands,
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
} from "../components/Operations.js";
import { PriorityBadge } from "../components/Priority.js";
import { Tooltip } from "../components/Tooltip.js";
import {
  type ExecutionDisplay,
  type ExecutionGroup,
  groupExecution,
  readExecutionDisplay,
  writeExecutionDisplay,
} from "../execution-display.js";
import {
  assignmentActivity,
  type ExecutionSort,
  executionStateRank,
  readExecutionSort,
  sortByActivity,
  sortByState,
  sortCapacityWaits,
  writeExecutionSort,
} from "../execution-sort.js";
import { routeHash, useRouteFilters } from "../route.js";
import { statusLabel } from "../status.js";
import { useBoardPan } from "../useBoardPan.js";
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
  (a.external ||
    a.queue_ahead !== undefined ||
    (a.runtime_ref !== null && !["lost", "unknown"].includes(a.runtime_state)));
const lost = (a: ExecutionAssignment) =>
  !a.external && ["lost", "unknown"].includes(a.runtime_state);
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
export function RunLine({ run }: { readonly run: RunView }) {
  const [elapsed, setElapsed] = useState(0);
  const waited = run.queue_warning?.waited_ms;
  useEffect(() => {
    setElapsed(0);
    if (waited === undefined) return;
    const sampled = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - sampled), 60_000);
    return () => clearInterval(timer);
  }, [waited]);
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
      {run.queue_ahead !== undefined && run.dispatch_reason && (
        <span>{run.dispatch_reason}</span>
      )}
      {run.status === "queued" &&
        run.queue_warning &&
        run.queue_warning.waited_ms + elapsed >=
          run.queue_warning.after_minutes * 60_000 && (
          <span className="queue-warning" role="note">
            已长时间排队（超过 {run.queue_warning.after_minutes} 分钟）
          </span>
        )}
      {runTime(run) && <Time value={runTime(run)} />}
    </>
  );
}
const NONE = "—";
const harnessLabel: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
};
/** C-106: the Harness; unknown or missing shows "—". */
export function runHarness(run: RunView | undefined): string {
  if (!run?.harness) return NONE;
  return harnessLabel[run.harness] ?? run.harness;
}
/** C-106: "model / effort"; an unknown part shows "—". */
export function runModelEffort(run: RunView | undefined): string {
  if (!run?.model) return NONE;
  return `${run.model} / ${run.effort || NONE}`;
}
/** C-207: Harness, model and effort as one muted line; no Run shows "—". */
export function runConfig(run: RunView | undefined): string {
  if (!run) return NONE;
  return `${runHarness(run)} / ${run.model || NONE} / ${run.effort || NONE}`;
}
const windowSize = (tokens: number) => {
  const [unit, size] =
    tokens >= 1_000_000
      ? ["M", 1_000_000]
      : tokens >= 1_000
        ? ["K", 1_000]
        : ["", 1];
  return `${Number((tokens / size).toFixed(1))}${unit}`;
};
/**
 * C-200 defaults: remind at 20% left, change sessions at 15% left. They mirror
 * the domain's contextUsageThresholds defaults and only apply when the server
 * sends no level (C-232 servers send the host's level with project overrides).
 */
const CONTEXT_HANDOFF_REMAINING = 20;
const CONTEXT_RESTART_REMAINING = 15;
export type ContextLevel = "normal" | "handoff" | "restart";
export interface ContextReading {
  /** Used share, two decimals, e.g. "62.34". */
  readonly used: string;
  readonly remaining: string;
  readonly level: ContextLevel;
  /** Window size, e.g. "200K". */
  readonly window: string;
  readonly usedTokens: number;
  readonly windowTokens: number;
  /** 0..100 for the meter. */
  readonly meter: number;
}
/**
 * C-207: the exact reading of the latest Run's context use. No recorded or
 * invalid value is undefined (shown as "—"), never a guess. The level follows
 * the host rule: remaining percentage rounded to 0.1, compared with the two
 * thresholds; the displayed two decimals never decide the level.
 */
export function contextReading(
  run: RunView | undefined,
): ContextReading | undefined {
  const usage = run?.context_usage;
  if (
    !usage ||
    !Number.isFinite(usage.used_ratio) ||
    !Number.isFinite(usage.window_tokens) ||
    usage.used_ratio < 0 ||
    usage.window_tokens <= 0
  )
    return undefined;
  const usedPct = usage.used_ratio * 100;
  const remaining = Math.round((100 - usedPct) * 10) / 10;
  // C-232: the server sends the host's own level (project thresholds); the
  // local default rule only covers servers that do not.
  const level: ContextLevel =
    usage.level !== undefined
      ? (usage.level ?? "normal")
      : remaining <= CONTEXT_RESTART_REMAINING
        ? "restart"
        : remaining <= CONTEXT_HANDOFF_REMAINING
          ? "handoff"
          : "normal";
  return {
    used: usedPct.toFixed(2),
    remaining: Math.max(0, 100 - usedPct).toFixed(2),
    level,
    window: windowSize(usage.window_tokens),
    usedTokens:
      usage.used_tokens ?? Math.round(usage.used_ratio * usage.window_tokens),
    windowTokens: usage.window_tokens,
    meter: Math.min(100, usedPct),
  };
}
const contextLevelLabel: Readonly<Record<ContextLevel, string>> = {
  normal: "用量正常",
  handoff: "提醒",
  restart: "换会话",
};
/** C-106 compatible one-line text, used in labels and the detail drawer. */
export function contextUsage(run: RunView | undefined): string {
  const reading = contextReading(run);
  if (!reading) return NONE;
  return `已用 ${reading.used}%，剩余 ${reading.remaining}%（${reading.window}）`;
}
/** The execution list consistently shows used percentage, including missing samples. */
function ContextCell({
  run,
  labelled = false,
}: {
  readonly run: RunView | undefined;
  readonly labelled?: boolean;
}) {
  const reading = contextReading(run);
  return (
    <span
      className={`execution-context execution-context-${reading?.level ?? "none"}`}
      data-level={reading?.level}
    >
      {labelled ? "上下文 " : ""}
      {reading ? `${reading.used}%` : NONE}
    </span>
  );
}
/** C-262: standing roles with their own label wording. */
const labelledStandingRoles = new Set(["pm", "host_ops"]);
/**
 * C-262: the label for a standing (project-level) Assignment, decided by
 * role_id and standing_mode only, never by the employee's name. A standing
 * role without its own wording falls back to "常驻（角色显示名）", or the
 * role_id when no display name is known.
 */
export function standingLabel(
  a: Pick<ExecutionAssignment, "role_id" | "standing_mode">,
  roleName?: string,
): string {
  if (a.role_id === "pm") {
    if (a.standing_mode === "office") return "常驻 PM · 前台";
    if (a.standing_mode === "ops") return "常驻 PM · 后台";
    return "常驻 PM（项目级）";
  }
  if (a.role_id === "host_ops") return "主机运维（常驻）";
  return `常驻（${roleName?.trim() || a.role_id}）`;
}
/**
 * C-207: what the Assignment is working on; Card, priority and work item.
 * C-232: the Card title follows on its own line, cut to one line with the
 * full title in the tooltip; the Card id above always stays visible.
 */
function TaskCell({
  a,
  projectId,
  roleName,
  tooltipClearAbove,
  trailing,
}: {
  readonly a: ExecutionAssignment;
  readonly projectId: string;
  readonly roleName?: string | undefined;
  readonly tooltipClearAbove?: string | undefined;
  readonly trailing?: ReactNode;
}) {
  const row = (
    <IdentityRow className="execution-task">
      {a.work_item_id ? (
        <>
          <CardLink
            projectId={projectId}
            id={a.card_id}
            tooltipClearAbove={tooltipClearAbove}
          />
          <PriorityBadge value={a.card_priority ?? 0} />
          <IdTag id={a.work_item_id} label="工作项" />
        </>
      ) : (
        <span className="execution-standing">{standingLabel(a, roleName)}</span>
      )}
      {trailing}
    </IdentityRow>
  );
  if (!a.work_item_id || !a.card_title) return row;
  return (
    <div className="execution-task-cell">
      {row}
      <span className="execution-task-title" title={a.card_title}>
        {a.card_title}
      </span>
    </div>
  );
}
/**
 * C-207: the runtime state first; an abnormal Assignment status (suspended,
 * released) always shows next to it, the normal "active" never does.
 */
function RuntimeState({ a }: { readonly a: ExecutionAssignment }) {
  return (
    <>
      {a.verification_activity && (
        <StatusTag
          status={a.verification_activity.status}
          label={a.verification_activity.label}
        />
      )}
      {a.external ? (
        <span className="execution-external">外接身份</span>
      ) : (
        <StatusTag status={a.runtime_state} />
      )}
      {a.status !== "active" && a.status !== a.runtime_state && (
        <StatusTag status={a.status} />
      )}
    </>
  );
}
const abnormalRun = (run: RunView) =>
  ["failed", "cancelled", "blocked"].includes(run.outcome ?? run.status);
/** C-207: the second status line: queue position, waits or a bad outcome. */
function RunNote({
  a,
  run,
}: {
  readonly a: ExecutionAssignment;
  readonly run: RunView | undefined;
}) {
  const [elapsed, setElapsed] = useState(0);
  const waited = run?.queue_warning?.waited_ms;
  useEffect(() => {
    setElapsed(0);
    if (waited === undefined) return;
    const sampled = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - sampled), 60_000);
    return () => clearInterval(timer);
  }, [waited]);
  if (a.external) return <span className="hint">由对接的 Agent 自行拉取</span>;
  if (!run) return null;
  const longQueue =
    run.status === "queued" &&
    run.queue_warning &&
    run.queue_warning.waited_ms + elapsed >=
      run.queue_warning.after_minutes * 60_000;
  return (
    <>
      {run.queue_ahead !== undefined && run.dispatch_reason && (
        <span>{run.dispatch_reason}</span>
      )}
      {run.queue_reason === "runtime_unavailable" ? (
        <span className="hint">等待运行环境恢复</span>
      ) : run.status === "queued" ? (
        <StatusTag
          status="queued"
          label={
            run.queue_ahead !== undefined
              ? `排队中（前面还有 ${run.queue_ahead} 个）`
              : "排队中"
          }
        />
      ) : abnormalRun(run) ? (
        <StatusTag
          status={run.outcome ?? run.status}
          label={`最近执行${statusLabel(run.outcome ?? run.status)}`}
        />
      ) : null}
      {longQueue && (
        <span className="queue-warning" role="note">
          已长时间排队（超过 {run.queue_warning?.after_minutes} 分钟）
        </span>
      )}
    </>
  );
}
function Activity({ value }: { readonly value: string | undefined }) {
  return value ? (
    <Time value={value} />
  ) : (
    <span className="hint">尚无记录</span>
  );
}
/** Clicks on the row's own links and buttons do their own thing. */
const interactive = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("a, button, input, select, textarea, summary") !== null;
interface RowProps {
  readonly a: ExecutionAssignment;
  readonly run: RunView | undefined;
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpen: (trigger: HTMLElement) => void;
  /** C-262: the role's display name, for the standing-label fallback. */
  readonly roleName?: string | undefined;
  readonly lane?: boolean;
}
/** C-106: the Assignment id opens the drawer; no separate 详情 button. */
function OpenButton({
  a,
  open,
  onOpen,
  button,
}: Pick<RowProps, "a" | "open" | "onOpen"> & {
  readonly button: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Tooltip content={`${a.role_id} v${a.role_version}`}>
      <button
        ref={button}
        type="button"
        className="quiet execution-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`查看 ${a.id} 详情`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(event.currentTarget);
        }}
      >
        <IdBadge id={a.id} />
      </button>
    </Tooltip>
  );
}
function AssignmentRow({
  a,
  run,
  projectId,
  open,
  onOpen,
  roleName,
}: RowProps) {
  const button = useRef<HTMLButtonElement>(null);
  return (
    <tr
      className={`execution-row${open ? " selected" : ""}`}
      onClick={(event) => {
        if (!interactive(event.target) && button.current)
          onOpen(button.current);
      }}
    >
      <td data-column="employee">
        <IdentityRow className="execution-employee">
          <EmployeeIdentity {...a} author_role={a.role_id} />
          <OpenButton a={a} open={open} onOpen={onOpen} button={button} />
        </IdentityRow>
      </td>
      <td data-column="task">
        <TaskCell a={a} projectId={projectId} roleName={roleName} />
      </td>
      <td data-column="state">
        <div className="execution-state">
          <RuntimeState a={a} />
        </div>
        <div className="execution-state-note">
          <RunNote a={a} run={run} />
        </div>
      </td>
      <td data-column="context">
        <ContextCell run={run} />
      </td>
      <td data-column="config" className="execution-config">
        <span className="execution-config-text" title={runConfig(run)}>
          <span className="execution-config-value">{runConfig(run)}</span>
        </span>
      </td>
      <td data-column="activity">
        <Activity value={assignmentActivity(a, run)} />
      </td>
    </tr>
  );
}
/** C-207: the same Assignment as a card below 760px; DOM order = reading order. */
function AssignmentCard({
  a,
  run,
  projectId,
  open,
  onOpen,
  roleName,
  lane = false,
}: RowProps) {
  const button = useRef<HTMLButtonElement>(null);
  const name = a.employee?.name ?? a.author_display ?? a.role_id;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the Assignment id button is the keyboard path.
    <li
      className={`execution-card${lane ? " card-tile execution-lane-card" : ""}${open ? " selected" : ""}`}
      aria-label={`${name} ${a.id}`}
      onClick={(event) => {
        if (!interactive(event.target) && button.current)
          onOpen(button.current);
      }}
    >
      {!lane && (
        <IdentityRow className="execution-card-head">
          <EmployeeIdentity {...a} author_role={a.role_id} />
          <span className="execution-state">
            <RuntimeState a={a} />
          </span>
        </IdentityRow>
      )}
      <TaskCell
        a={a}
        projectId={projectId}
        roleName={roleName}
        tooltipClearAbove=".execution-card"
        trailing={
          lane ? (
            <span className="execution-state">
              <RuntimeState a={a} />
            </span>
          ) : undefined
        }
      />
      <div className="execution-state-note">
        <RunNote a={a} run={run} />
      </div>
      <div className="execution-card-context">
        <ContextCell run={run} labelled />
      </div>
      <IdentityRow className="execution-card-foot">
        <OpenButton a={a} open={open} onOpen={onOpen} button={button} />
        <span className="hint">
          最近活动 <Activity value={assignmentActivity(a, run)} />
        </span>
        {lane && (
          <button
            type="button"
            className="quiet execution-card-more"
            aria-label="运行配置与最近执行"
            title="运行配置与最近执行"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        )}
      </IdentityRow>
      {lane && run && (
        <p className="execution-card-config-line">{runConfig(run)}</p>
      )}
      {lane ? (
        <div id={detailsId} hidden={!expanded}>
          {run ? (
            <p className="execution-card-config-line execution-run">
              <RunLine run={run} />
            </p>
          ) : (
            <p className="execution-card-config-line">尚无 Run</p>
          )}
        </div>
      ) : (
        <details className="execution-card-config">
          <summary className="execution-card-config-summary">
            运行配置与最近执行
          </summary>
          <p className="execution-card-config-line">{runConfig(run)}</p>
          {run ? (
            <p className="execution-card-config-line execution-run">
              <RunLine run={run} />
            </p>
          ) : (
            <p className="execution-card-config-line">尚无 Run</p>
          )}
        </details>
      )}
    </li>
  );
}
const NARROW_QUERY = "(max-width: 760px)";
const narrowQuery = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY)
    : undefined;
/** Only the current layout is rendered, so assistive tech never reads both. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => narrowQuery()?.matches ?? false);
  useEffect(() => {
    const list = narrowQuery();
    if (!list) return;
    setNarrow(list.matches);
    const sync = (event: MediaQueryListEvent) => setNarrow(event.matches);
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, []);
  return narrow;
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
    <div className="execution-drawer">
      <dl className="execution-basics">
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
  );
}
function GroupLabel({ group }: { readonly group: ExecutionGroup }) {
  const name = group.employee?.name ?? "未分配员工";
  return (
    <IdentityRow>
      <EmployeeIdentity
        employee={group.employee}
        author_display={name}
        showTitle={false}
      />
      <span className="hint">
        {group.rows.length} 个 Assignment ·{" "}
        {group.rows.filter((a) => executionStateRank(a) === 0).length} 个运行中
      </span>
    </IdentityRow>
  );
}

function GroupHeading({
  group,
  collapsed,
  onToggle,
  controls,
}: {
  readonly group: ExecutionGroup;
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
  readonly controls?: string;
}) {
  const name = group.employee?.name ?? "未分配员工";
  return (
    <div className="execution-group-heading">
      <GroupLabel group={group} />
      {onToggle && (
        <button
          type="button"
          className="quiet"
          aria-label={`${collapsed ? "展开" : "折叠"}${name}分组`}
          aria-expanded={!collapsed}
          aria-controls={controls}
          onClick={onToggle}
        >
          {collapsed ? "展开" : "折叠"}
          <span aria-hidden="true">{collapsed ? " ▸" : " ▾"}</span>
        </button>
      )}
    </div>
  );
}

/** Mount with the scroll region so switching modes attaches/cleans up panning. */
function EmployeeLanes({ children }: { readonly children: ReactNode }) {
  const scroller = useRef<HTMLElement>(null);
  useBoardPan(scroller);
  return (
    <section
      ref={scroller}
      className="execution-lanes"
      aria-label="员工泳道"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the employee lanes.
      tabIndex={0}
    >
      {children}
    </section>
  );
}

function SortButton({
  sort,
  column,
  onChange,
}: {
  readonly sort: ExecutionSort;
  readonly column: "activity" | "state";
  readonly onChange: (next: ExecutionSort) => void;
}) {
  const state = column === "state";
  const active = state ? sort.startsWith("state-") : !sort.startsWith("state-");
  const ascending = state ? sort === "state-asc" : sort === "asc";
  const label = state ? "运行状态" : "最近活动";
  const next = state
    ? sort === "state-asc"
      ? "state-desc"
      : "state-asc"
    : sort === "desc"
      ? "asc"
      : "desc";
  return (
    <button
      type="button"
      className="quiet execution-sort"
      onClick={() => onChange(next)}
      aria-label={`${label}${active ? (ascending ? "升序" : "降序") : "未排序"}，点击${next.endsWith("desc") ? "降序" : "升序"}`}
      title={
        state
          ? "运行中 → 排队中 → 失联/未知 → 空闲 → 已结束"
          : "按最近活动时间排序"
      }
    >
      {label}
      <span aria-hidden="true">
        {active ? (ascending ? " ↑" : " ↓") : " ↕"}
      </span>
    </button>
  );
}

export function ExecutionPage({
  client,
  projectId,
  revision = 0,
  contextRevision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
  /** C-232: bumps when the host's context samples change (SSE `context`). */
  contextRevision?: number;
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
  const view =
    filters.view && Object.hasOwn(viewLabel, filters.view)
      ? filters.view
      : "working";
  const narrow = useNarrow();
  const load = useCallback(
    () => client.execution(projectId),
    [client, projectId],
  );
  // Both counters only grow, so their sum changes whenever either does.
  const { data, pending, error, reload, interactive } = useResource(
    load,
    revision + contextRevision,
  );
  // C-262: role display names, read only when a standing role has no label
  // of its own; a failed read keeps the role_id fallback.
  const [roleNames, setRoleNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const needsRoleNames =
    data?.assignments.some(
      (a) => !a.work_item_id && !labelledStandingRoles.has(a.role_id),
    ) ?? false;
  useEffect(() => {
    if (!needsRoleNames) return;
    let live = true;
    client.roles(projectId).then(
      (list) => {
        if (live)
          setRoleNames(
            new Map(list.roles.map((r) => [r.role_id, r.display_name])),
          );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, projectId, needsRoleNames]);
  const [sort, setSort] = useState<ExecutionSort>(() =>
    readExecutionSort(projectId),
  );
  useEffect(() => setSort(readExecutionSort(projectId)), [projectId]);
  const changeSort = (next: ExecutionSort) => {
    setSort(next);
    writeExecutionSort(projectId, next);
  };
  const [display, setDisplay] = useState<ExecutionDisplay>(() =>
    readExecutionDisplay(projectId),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groupsId = useId();
  useEffect(() => {
    setDisplay(readExecutionDisplay(projectId));
    setCollapsed(new Set());
  }, [projectId]);
  const changeDisplay = (next: ExecutionDisplay) => {
    setDisplay(next);
    writeExecutionDisplay(projectId, next);
  };
  const toggleGroup = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Runs arrive newest first, so the first match is the Assignment's latest.
  const latestRuns = new Map<string, RunView>();
  for (const run of data?.runs ?? []) {
    if (!latestRuns.has(run.assignment_id))
      latestRuns.set(run.assignment_id, run);
  }
  const latestRun = (assignmentId: string) => latestRuns.get(assignmentId);
  const assignments = sortByState(
    sortCapacityWaits(
      sortByActivity(
        (data?.assignments ?? []).filter((assignment) =>
          matchesView(assignment, view),
        ),
        (assignment) =>
          assignmentActivity(assignment, latestRun(assignment.id)),
        sort === "asc" ? "asc" : "desc",
      ),
    ),
    (a) => latestRun(a.id),
    sort,
  );
  const groups = groupExecution(assignments);
  const rowProps = (assignment: ExecutionAssignment): RowProps => ({
    a: assignment,
    run: latestRun(assignment.id),
    projectId,
    roleName: roleNames.get(assignment.role_id),
    open: assignment.id === selected,
    onOpen: (trigger) => open(assignment.id, trigger),
  });
  const cardList = (
    rows: readonly ExecutionAssignment[],
    lane = false,
    id?: string,
  ) => (
    <ul id={id} className="execution-cards" aria-label="Assignment 列表">
      {rows.map((a) => (
        <AssignmentCard key={a.id} {...rowProps(a)} lane={lane} />
      ))}
    </ul>
  );
  const heading = (group: ExecutionGroup) => (
    <GroupHeading
      group={group}
      collapsed={collapsed.has(group.id)}
      controls={`${groupsId}-${group.id}`}
      onToggle={() => toggleGroup(group.id)}
    />
  );
  const detail = data?.assignments.find((a) => a.id === selected);
  const detailLive =
    data?.runs.some(
      (run) => run.assignment_id === selected && unfinished(run),
    ) ?? false;
  return (
    <section aria-label="执行视图" className="execution-page">
      <PageTitle title="执行视图" />
      {assignments.some((a) => a.queue_order) && (
        <p className="hint">
          等待并发名额按收尾档位排序，同档按卡片优先级和触发先后。持续有高档工作时，新开工可能长期等待。
        </p>
      )}
      <FilterBar
        compact
        summary={
          data && (
            <>
              <span>
                显示 {assignments.length} / {data.assignments.length} 个
                Assignment
              </span>
              <span>{data.runs.filter(unfinished).length} 个未结束 Run</span>
            </>
          )
        }
        fields={[
          {
            key: "view",
            label: "筛选",
            includeAllOption: false,
            clearValue: "all",
            options: Object.entries(viewLabel).map(([value, label]) => ({
              value,
              label,
            })),
          },
        ]}
        values={{ ...filters, view }}
        onChange={setFilters}
      />
      <section
        className="execution-view-controls"
        aria-label="执行视图显示选项"
      >
        <fieldset className="execution-mode" aria-label="视图模式">
          <button
            type="button"
            className="quiet"
            aria-pressed={display.mode === "table"}
            onClick={() => changeDisplay({ ...display, mode: "table" })}
          >
            表格
          </button>
          <button
            type="button"
            className="quiet"
            aria-pressed={display.mode === "cards"}
            onClick={() => changeDisplay({ ...display, mode: "cards" })}
          >
            卡片
          </button>
        </fieldset>
        {display.mode === "table" && (
          <button
            type="button"
            className="quiet"
            aria-pressed={display.grouped}
            onClick={() =>
              changeDisplay({ ...display, grouped: !display.grouped })
            }
          >
            按员工分组
          </button>
        )}
        {(narrow || display.mode === "cards") && (
          <fieldset aria-label="排序">
            <SortButton sort={sort} column="state" onChange={changeSort} />
            <SortButton sort={sort} column="activity" onChange={changeSort} />
          </fieldset>
        )}
      </section>
      <Feedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
      />
      <ExecutionDiagnostics
        client={client}
        projectId={projectId}
        onOpen={open}
      />
      {data &&
        (assignments.length === 0 ? (
          <EmptyState>
            {view === "working"
              ? "现在没有工作中的 Assignment。切换筛选可查看全部、已释放或失联的 Assignment。"
              : `没有符合条件的 Assignment（${viewLabel[view] ?? view}）。`}
          </EmptyState>
        ) : display.mode === "cards" ? (
          <EmployeeLanes>
            {groups.map((group) => (
              <section
                key={group.id}
                className="execution-lane"
                aria-label={`${group.employee?.name ?? "未分配员工"}泳道`}
              >
                <div className="execution-lane-heading">
                  <strong>{group.employee?.name ?? "未分配员工"}</strong>
                  <span className="hint">
                    {" "}
                    · {group.rows.length} 个 Assignment ·{" "}
                    {
                      group.rows.filter((a) => executionStateRank(a) === 0)
                        .length
                    }{" "}
                    个运行中
                  </span>
                </div>
                {cardList(group.rows, true)}
              </section>
            ))}
          </EmployeeLanes>
        ) : narrow ? (
          display.grouped ? (
            <div className="execution-groups">
              {groups.map((group) => (
                <section
                  key={group.id}
                  aria-label={`${group.employee?.name ?? "未分配员工"}分组`}
                >
                  {heading(group)}
                  <div
                    id={`${groupsId}-${group.id}`}
                    hidden={collapsed.has(group.id)}
                  >
                    {cardList(group.rows)}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            cardList(assignments)
          )
        ) : (
          <div className="execution-table-scroll">
            <table className="execution-table">
              <colgroup>
                <col className="execution-col-employee" />
                <col />
                <col className="execution-col-state" />
                <col className="execution-col-context" />
                <col className="execution-col-config" />
                <col className="execution-col-activity" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">员工</th>
                  <th scope="col">正在做什么</th>
                  <th
                    scope="col"
                    aria-sort={
                      sort === "state-asc"
                        ? "ascending"
                        : sort === "state-desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <SortButton
                      sort={sort}
                      column="state"
                      onChange={changeSort}
                    />
                  </th>
                  <th scope="col">上下文用量</th>
                  <th scope="col">运行配置</th>
                  <th
                    scope="col"
                    aria-sort={
                      sort === "asc"
                        ? "ascending"
                        : sort === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <SortButton
                      sort={sort}
                      column="activity"
                      onChange={changeSort}
                    />
                  </th>
                </tr>
              </thead>
              <GroupedTableBody
                rows={assignments}
                groupBy={
                  display.grouped
                    ? (a) => a.employee?.id ?? "unassigned"
                    : undefined
                }
                groupName={(group) =>
                  group.rows[0]?.employee?.name ?? "未分配员工"
                }
                columns={6}
                headingClassName="execution-group-heading"
                collapsed={collapsed}
                onToggle={toggleGroup}
                renderLabel={(group) => (
                  <GroupLabel
                    group={{ ...group, employee: group.rows[0]?.employee }}
                  />
                )}
                renderRow={(a) => <AssignmentRow key={a.id} {...rowProps(a)} />}
              />
            </table>
          </div>
        ))}
      {!!data?.machines.length && (
        <details className="execution-machines">
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
      <Drawer
        open={detail !== undefined}
        onOpenChange={(next) => {
          if (!next) setSelected(undefined);
        }}
        className="execution-drawer-content"
        // C-75: rows stay usable while the drawer is open, so another row's
        // Assignment replaces the content; any other outside click closes it.
        modal={false}
        onInteractOutside={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest(".execution-table tbody tr, .execution-card")
          )
            event.preventDefault();
        }}
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
            run={latestRun(detail.id)}
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
