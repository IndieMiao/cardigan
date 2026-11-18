import {
  sessionMaintenanceNeedsAttention,
  sessionMaintenanceReasons,
} from "@cardigan/domain";
import { ChevronDown, Columns3, List } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  CardiganClient,
  ExecutionAssignment,
  ExecutionData,
  ExecutionRunPage,
  RunView,
} from "../api.js";
import { DetailsTip } from "../components/DetailsTip.js";
import { Drawer } from "../components/Drawer.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { ExecutionDiagnostics } from "../components/ExecutionDiagnostics.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  LongContent,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { GroupedTableBody } from "../components/GroupedTableBody.js";
import { IdentityRow } from "../components/IdentityRow.js";
import { IdBadge } from "../components/IdTag.js";
import { BoardCardLayout } from "../components/layout/BoardCardLayout.js";
import {
  CardDetailLayout,
  cardDetailDrawerClassName,
} from "../components/layout/CardDetailLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { Menu } from "../components/Menu.js";
import {
  AttachCommands,
  CardLink,
  CopyCommand,
  cliCommand,
  Feedback,
} from "../components/Operations.js";
import { PriorityBadge } from "../components/Priority.js";
import { Tooltip } from "../components/Tooltip.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { SearchInput } from "../components/ui/input.js";
import { SelectControl } from "../components/ui/select-control.js";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { ViewSwitch } from "../components/ViewSwitch.js";
import {
  type ExecutionDisplay,
  type ExecutionGroup,
  groupExecution,
  readExecutionDisplay,
  writeExecutionDisplay,
} from "../execution-display.js";
import {
  assignmentMachine,
  machineLabel,
  runMachine,
} from "../execution-machine.js";
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

const MachinesContext = createContext<ExecutionData["machines"]>([]);
function MachineBadge({
  id,
  plain = false,
}: {
  readonly id: string;
  readonly plain?: boolean;
}) {
  const machines = useContext(MachinesContext);
  const Label = plain ? "span" : Badge;
  return (
    <Label
      title={id || "没有机器记录"}
      aria-label={`机器：${machineLabel(id, machines)}`}
    >
      {machineLabel(id, machines)}
    </Label>
  );
}
function AssignmentMachine({
  a,
  plain = false,
}: {
  readonly a: ExecutionAssignment;
  readonly plain?: boolean;
}) {
  const machines = useContext(MachinesContext);
  return <MachineBadge id={assignmentMachine(a, machines)} plain={plain} />;
}
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
  return text.trim() ? (
    <LongContent lines={2}>{text}</LongContent>
  ) : (
    <span className="hint">无摘要</span>
  );
}
function useRunDetails(run: RunView | undefined): string[] {
  const [elapsed, setElapsed] = useState(0);
  const waited = run?.queue_warning?.waited_ms;
  useEffect(() => {
    setElapsed(0);
    if (waited === undefined) return;
    const sampled = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - sampled), 60_000);
    return () => clearInterval(timer);
  }, [waited]);
  if (!run) return [];
  return [
    run.queue_reason === "runtime_unavailable" ? "等待运行环境恢复" : "",
    run.queue_ahead !== undefined
      ? `排队中（前面还有 ${run.queue_ahead} 个）`
      : "",
    run.dispatch_reason ?? "",
    run.status === "queued" &&
    run.queue_warning &&
    run.queue_warning.waited_ms + elapsed >=
      run.queue_warning.after_minutes * 60_000
      ? `已长时间排队（超过 ${run.queue_warning.after_minutes} 分钟）`
      : "",
    abnormalRun(run) ? `最近执行${statusLabel(run.outcome ?? run.status)}` : "",
  ];
}
export function RunLine({ run }: { readonly run: RunView }) {
  const details = useRunDetails(run);
  return (
    <>
      <IdTag id={run.id} label={runKind(run)} />
      <DetailsTip lines={[statusLabel(run.outcome ?? run.status), ...details]}>
        <Button variant="ghost" className="ui-status-tip">
          <StatusTag status={run.outcome ?? run.status} />
        </Button>
      </DetailsTip>
      <MachineBadge id={runMachine(run)} />
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
    <span className="execution-context hint" data-level={reading?.level}>
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
 * C-232: the full Card title follows its identifiers. Table titles use the
 * shared data-title spacing; card layouts retain their inline title spacing.
 */
function TaskCell({
  a,
  projectId,
  roleName,
  tooltipClearAbove,
  trailing,
  table = false,
}: {
  readonly a: ExecutionAssignment;
  readonly projectId: string;
  readonly roleName?: string | undefined;
  readonly tooltipClearAbove?: string | undefined;
  readonly trailing?: ReactNode;
  readonly table?: boolean;
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
      <span
        className={`execution-task-title card-table-title${table ? " ui-data-title" : ""}`}
        title={a.card_title}
      >
        {a.card_title}
      </span>
    </div>
  );
}
/**
 * C-207: the runtime state first; an abnormal Assignment status (suspended,
 * released) always shows next to it, the normal "active" never does.
 */
function RuntimeState({
  a,
  run,
}: {
  readonly a: ExecutionAssignment;
  readonly run?: RunView | undefined;
}) {
  const details = useRunDetails(run);
  const maintenance = a.session_maintenance;
  return (
    <DetailsTip
      lines={[
        a.external ? "由对接的 Agent 自行拉取" : statusLabel(a.runtime_state),
        ...details,
        a.dispatch_reason ?? "",
        ...(a.queue_order
          ? [
              "等待并发名额按收尾档位排序，同档按卡片优先级和触发先后。持续有高档工作时，新开工可能长期等待。",
            ]
          : []),
        maintenance && sessionMaintenanceNeedsAttention(maintenance.reason)
          ? sessionMaintenanceReasons[maintenance.reason]
          : "",
        maintenance?.candidate
          ? "原生 hc attach、桌面接入及输入输出无法完整观测，自动回收可能打断这些交互。查看会话维护帮助。"
          : "",
      ]}
    >
      <Button
        variant="ghost"
        className="ui-status-tip"
        aria-label={`${a.id} 状态详情`}
      >
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
        {!a.external && run?.status === "queued" && (
          <StatusTag status="queued" />
        )}
        {run && abnormalRun(run) && (
          <StatusTag status={run.outcome ?? run.status} />
        )}
        {a.status !== "active" && a.status !== a.runtime_state && (
          <StatusTag status={a.status} />
        )}
      </Button>
    </DetailsTip>
  );
}

function MaintenanceReason({
  a,
  projectId,
  detail = false,
}: {
  readonly a: ExecutionAssignment;
  readonly projectId: string;
  readonly detail?: boolean;
}) {
  const maintenance = a.session_maintenance;
  if (
    !maintenance ||
    (!detail && !sessionMaintenanceNeedsAttention(maintenance.reason))
  )
    return null;
  const label = sessionMaintenanceReasons[maintenance.reason];
  return (
    <div className="execution-maintenance">
      {maintenance.candidate || maintenance.reason === "idle_candidate" ? (
        <Tooltip content="原生 hc attach、桌面接入及输入输出无法完整观测，自动回收可能打断这些交互。查看会话维护帮助。">
          <a
            href={routeHash({
              kind: "help",
              projectId,
              filters: { doc: "04-session-maintenance" },
            })}
          >
            {label}
          </a>
        </Tooltip>
      ) : (
        label
      )}
    </div>
  );
}
const abnormalRun = (run: RunView) =>
  ["failed", "cancelled", "blocked"].includes(run.outcome ?? run.status);
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
  readonly showEmployee?: boolean;
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
      <Button
        ref={button}
        type="button"
        variant="ghost"
        className="ui-status-tip execution-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`查看 ${a.id} 详情`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(event.currentTarget);
        }}
      >
        <IdBadge id={a.id} />
      </Button>
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
    <TableRow
      className={`execution-row${open ? " selected" : ""}`}
      onClick={(event) => {
        if (!interactive(event.target) && button.current)
          onOpen(button.current);
      }}
    >
      <TableCell data-column="employee">
        <IdentityRow className="execution-employee">
          <EmployeeIdentity {...a} author_role={a.role_id} />
          <OpenButton a={a} open={open} onOpen={onOpen} button={button} />
        </IdentityRow>
      </TableCell>
      <TableCell data-column="task">
        <TaskCell a={a} projectId={projectId} roleName={roleName} table />
      </TableCell>
      <TableCell data-column="state">
        <div className="execution-state">
          <RuntimeState a={a} run={run} />
        </div>
      </TableCell>
      <TableCell data-column="machine">
        <AssignmentMachine a={a} />
      </TableCell>
      <TableCell data-column="context">
        <ContextCell run={run} />
      </TableCell>
      <TableCell data-column="config" className="execution-config">
        <span className="execution-config-text" title={runConfig(run)}>
          <span className="execution-config-value">{runConfig(run)}</span>
        </span>
      </TableCell>
      <TableCell data-column="activity">
        <Activity value={assignmentActivity(a, run)} />
      </TableCell>
    </TableRow>
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
  showEmployee = false,
}: RowProps) {
  const button = useRef<HTMLButtonElement>(null);
  const name = a.employee?.name ?? a.author_display ?? a.role_id;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the Assignment id button is the keyboard path.
    <li
      className={`execution-card${lane ? " execution-lane-card" : ""}${open ? " selected" : ""}`}
      aria-label={`${name} ${a.id}`}
      onClick={(event) => {
        if (!interactive(event.target) && button.current)
          onOpen(button.current);
      }}
    >
      <BoardCardLayout className="card-tile ui-surface-card">
        {(!lane || showEmployee) && (
          <IdentityRow className="execution-card-head">
            <EmployeeIdentity {...a} author_role={a.role_id} />
            <span className="execution-state">
              <RuntimeState a={a} run={run} />
            </span>
          </IdentityRow>
        )}
        <TaskCell
          a={a}
          projectId={projectId}
          roleName={roleName}
          tooltipClearAbove=".execution-card"
          trailing={
            lane && !showEmployee ? (
              <span className="execution-state">
                <RuntimeState a={a} run={run} />
              </span>
            ) : undefined
          }
        />

        <IdentityRow className="execution-card-context metadata">
          <AssignmentMachine a={a} />
          <ContextCell run={run} labelled />
        </IdentityRow>
        <IdentityRow className="execution-card-foot">
          <OpenButton a={a} open={open} onOpen={onOpen} button={button} />
          <span className="hint">
            最近活动 <Activity value={assignmentActivity(a, run)} />
          </span>
          {lane && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="execution-card-more"
              aria-label="运行配置与最近执行"
              title="运行配置与最近执行"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(!expanded)}
            >
              <span aria-hidden="true">⋯</span>
            </Button>
          )}
        </IdentityRow>
        {lane && run && (
          <span className="execution-card-config-line hint">
            {runConfig(run)}
          </span>
        )}
        {lane ? (
          <div id={detailsId} hidden={!expanded}>
            {run ? (
              <p className="execution-card-config-line execution-run metadata">
                <RunLine run={run} />
              </p>
            ) : (
              <p className="execution-card-config-line hint">尚无 Run</p>
            )}
          </div>
        ) : (
          <details className="execution-card-config">
            <summary className="execution-card-config-summary">
              运行配置与最近执行
            </summary>
            <span className="execution-card-config-line hint">
              {runConfig(run)}
            </span>
            {run ? (
              <p className="execution-card-config-line execution-run metadata">
                <RunLine run={run} />
              </p>
            ) : (
              <p className="execution-card-config-line hint">尚无 Run</p>
            )}
          </details>
        )}
      </BoardCardLayout>
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
function GroupLabel({ group }: { readonly group: ExecutionGroup }) {
  const name = group.label ?? group.employee?.name ?? "未分配员工";
  return (
    <IdentityRow>
      {group.machine ? (
        <MachineBadge id={group.id} />
      ) : (
        <EmployeeIdentity
          employee={group.employee}
          author_display={name}
          showTitle={false}
        />
      )}
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
  const name = group.label ?? group.employee?.name ?? "未分配员工";
  return (
    <div className="execution-group-heading table-group-heading">
      <GroupLabel group={group} />
      {onToggle && (
        <Button
          type="button"
          className="quiet"
          aria-label={`${collapsed ? "展开" : "折叠"}${name}分组`}
          aria-expanded={!collapsed}
          aria-controls={controls}
          onClick={onToggle}
        >
          {collapsed ? "展开" : "折叠"}
          <span aria-hidden="true">{collapsed ? " ▸" : " ▾"}</span>
        </Button>
      )}
    </div>
  );
}

/** Mount with the scroll region so switching modes attaches/cleans up panning. */
function EmployeeLanes({
  children,
  narrow,
  machine,
}: {
  readonly children: ReactNode;
  readonly narrow: boolean;
  readonly machine: boolean;
}) {
  const scroller = useRef<HTMLElement>(null);
  useBoardPan(scroller);
  return (
    <section
      ref={scroller}
      className={`execution-lanes ${narrow ? "board-list" : "board"}`}
      aria-label={machine ? "机器泳道" : "员工泳道"}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the employee lanes.
      tabIndex={0}
    >
      {children}
    </section>
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
  const refreshKey = `cardigan.execution.refresh.${projectId}`;
  const readRefresh = (key: string) => {
    try {
      const n = Number(localStorage.getItem(key));
      return [0, 10000, 30000, 60000, 300000].includes(n) ? n : 0;
    } catch {
      return 0;
    }
  };
  const [refreshChoice, setRefreshChoice] = useState(() => ({
    key: refreshKey,
    value: readRefresh(refreshKey),
  }));
  const interval =
    refreshChoice.key === refreshKey
      ? refreshChoice.value
      : readRefresh(refreshKey);
  useEffect(() => {
    if (!interval) return;
    const timer = window.setInterval(() => {
      if (!pending && !document.hidden) reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, pending, reload]);
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
        (data?.assignments ?? []).filter((a) => {
          const machine = assignmentMachine(a, data?.machines ?? []);
          const query = filters.q?.trim().toLocaleLowerCase();
          return (
            matchesView(a, view) &&
            (!filters.machine || machine === filters.machine) &&
            (!query ||
              [
                a.id,
                a.employee?.name,
                a.role_id,
                a.card_id,
                a.work_item_id,
                a.card_title,
                machine,
                machineLabel(machine, data?.machines ?? []),
              ].some((value) => value?.toLocaleLowerCase().includes(query)))
          );
        }),
        (assignment) =>
          assignmentActivity(assignment, latestRun(assignment.id)),
        sort === "asc" ? "asc" : "desc",
      ),
    ),
    (a) => latestRun(a.id),
    sort,
  );
  const groupBy = display.groupBy ?? "employee";
  const groups = groupExecution(assignments, groupBy, data?.machines);
  const groupKey = (a: ExecutionAssignment) =>
    groupBy === "machine"
      ? assignmentMachine(a, data?.machines ?? [])
      : (a.employee?.id ?? "unassigned");
  const groupName = (id: string) =>
    groups.find((g) => g.id === id)?.label ??
    groups.find((g) => g.id === id)?.employee?.name ??
    "未分配员工";
  const machineOptions = [
    ...new Set([
      ...(data?.machines.map((m) => m.id) ?? []),
      ...(data?.assignments.map((a) => assignmentMachine(a, data.machines)) ??
        []),
    ]),
  ]
    .filter(Boolean)
    .map((value) => ({
      value,
      label: machineLabel(value, data?.machines ?? []),
    }));
  const rowProps = (assignment: ExecutionAssignment): RowProps => ({
    a: assignment,
    run: latestRun(assignment.id),
    projectId,
    roleName: roleNames.get(assignment.role_id),
    showEmployee: groupBy === "machine",
    open: assignment.id === selected,
    onOpen: (trigger) => open(assignment.id, trigger),
  });
  const cardList = (
    rows: readonly ExecutionAssignment[],
    lane = false,
    id?: string,
  ) => (
    <ul
      id={id}
      className="execution-cards board-list"
      aria-label="Assignment 列表"
    >
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
    <MachinesContext.Provider value={data?.machines ?? []}>
      <section aria-label="执行视图" className="execution-page ui-workspace">
        <PageHeader title="执行视图" capacityByMachine />
        <FilterBar
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
              clearValue: "all",
              options: Object.entries(viewLabel).map(([value, label]) => ({
                value,
                label,
              })),
              render: (value, setValue) => (
                <SelectControl
                  aria-label="筛选"
                  prefix="筛选"
                  value={value}
                  onValueChange={setValue}
                >
                  {Object.entries(viewLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </SelectControl>
              ),
            },
            {
              key: "machine",
              label: "机器",
              options: machineOptions,
              render: (value, setValue) => (
                <SelectControl
                  aria-label="机器"
                  prefix="机器"
                  value={value}
                  onValueChange={setValue}
                >
                  <option value="">全部</option>
                  {machineOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </SelectControl>
              ),
            },
            {
              key: "q",
              label: "搜索",
              grow: true,
              render: (value, setValue) => (
                <SearchInput
                  aria-label="搜索员工、任务或机器"
                  placeholder="搜索员工、任务或机器"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              ),
            },
            {
              key: "display",
              label: "显示",
              render: () => (
                <Menu
                  label="显示"
                  trigger={
                    <Button>
                      显示
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  }
                  items={[
                    {
                      id: "grouped",
                      label: "分组",
                      kind: "checkbox",
                      checked: display.grouped,
                      onCheckedChange: (checked) =>
                        changeDisplay({ ...display, grouped: checked }),
                    },
                    ...(["employee", "machine"] as const).map((field) => ({
                      id: field,
                      label: `分组字段：${field === "machine" ? "机器" : "员工"}`,
                      kind: "checkbox" as const,
                      checked: groupBy === field,
                      onCheckedChange: () => {
                        setCollapsed(new Set());
                        changeDisplay({
                          ...display,
                          grouped: true,
                          groupBy: field,
                        });
                      },
                    })),
                    ...(
                      ["state-asc", "state-desc", "desc", "asc"] as const
                    ).map((value) => ({
                      id: value,
                      label: `${value.startsWith("state") ? "运行状态" : "最近活动"}${value.endsWith("desc") ? "降序" : "升序"}`,
                      kind: "checkbox" as const,
                      checked: sort === value,
                      onCheckedChange: () => changeSort(value),
                    })),
                  ]}
                />
              ),
            },
          ]}
          values={{ ...filters, view }}
          onChange={setFilters}
        >
          <div className="ui-action-row">
            <div className="ui-refresh-controls shrink-0">
              <label>
                <SelectControl
                  aria-label="自动刷新"
                  value={interval}
                  onValueChange={(value) => {
                    const next = Number(value);
                    setRefreshChoice({ key: refreshKey, value: next });
                    try {
                      localStorage.setItem(refreshKey, String(next));
                    } catch {
                      /* Optional preference. */
                    }
                  }}
                >
                  <option value={10000}>10 秒</option>
                  <option value={30000}>30 秒</option>
                  <option value={60000}>60 秒</option>
                  <option value={300000}>5 分钟</option>
                  <option value={0}>关闭</option>
                </SelectControl>
              </label>
              <Button
                variant="ghost"
                className="shrink-0"
                aria-disabled={pending}
                onClick={() => {
                  if (!pending) reload();
                }}
              >
                立即刷新
              </Button>
            </div>
            <ViewSwitch
              label="视图模式"
              value={display.mode}
              showLabel
              onChange={(mode) =>
                changeDisplay({
                  ...display,
                  mode: mode === "cards" ? "cards" : "table",
                })
              }
              options={[
                { value: "table", label: "表格", icon: <List /> },
                { value: "cards", label: "卡片", icon: <Columns3 /> },
              ]}
            />
          </div>
        </FilterBar>
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
            <EmptyState>没有符合条件的 Assignment</EmptyState>
          ) : display.mode === "cards" ? (
            <EmployeeLanes narrow={narrow} machine={groupBy === "machine"}>
              {groups.map((group) => (
                <section
                  key={group.id}
                  className={`execution-lane ${narrow ? "board-list" : "board-column"}`}
                  aria-label={`${group.label ?? group.employee?.name ?? "未分配员工"}泳道`}
                >
                  <div className="execution-lane-heading board-column-title">
                    <GroupLabel group={group} />
                  </div>
                  <div className={narrow ? undefined : "board-lane-cards"}>
                    {cardList(group.rows, true)}
                  </div>
                </section>
              ))}
            </EmployeeLanes>
          ) : narrow ? (
            display.grouped ? (
              <div className="execution-groups board-list">
                {groups.map((group) => (
                  <section
                    key={group.id}
                    aria-label={`${group.label ?? group.employee?.name ?? "未分配员工"}分组`}
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
            <div className="execution-table-scroll card-table-scroll">
              <Table className="execution-table card-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>员工</TableHead>
                    <TableHead>正在做什么</TableHead>
                    <TableHead
                      sort={
                        sort === "state-asc"
                          ? "ascending"
                          : sort === "state-desc"
                            ? "descending"
                            : "none"
                      }
                      onSort={() =>
                        changeSort(
                          sort === "state-asc" ? "state-desc" : "state-asc",
                        )
                      }
                    >
                      运行状态
                    </TableHead>
                    <TableHead>机器</TableHead>
                    <TableHead>上下文用量</TableHead>
                    <TableHead>运行配置</TableHead>
                    <TableHead
                      sort={
                        sort === "asc"
                          ? "ascending"
                          : sort === "desc"
                            ? "descending"
                            : "none"
                      }
                      onSort={() =>
                        changeSort(sort === "desc" ? "asc" : "desc")
                      }
                    >
                      最近活动
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <GroupedTableBody
                  rows={assignments}
                  groupBy={display.grouped ? groupKey : undefined}
                  groupName={(group) => groupName(group.id)}
                  columns={7}
                  headingClassName="execution-group-heading"
                  collapsed={collapsed}
                  onToggle={toggleGroup}
                  renderLabel={(group) => (
                    <GroupLabel
                      group={{
                        ...group,
                        employee: group.rows[0]?.employee,
                        machine: groupBy === "machine",
                        label: groupName(group.id),
                      }}
                    />
                  )}
                  renderRow={(a) => (
                    <AssignmentRow key={a.id} {...rowProps(a)} />
                  )}
                />
              </Table>
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
          className={cardDetailDrawerClassName ?? ""}
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
    </MachinesContext.Provider>
  );
}
