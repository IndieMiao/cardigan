import {
  HARNESS_CATALOG,
  isHarness,
  sessionMaintenanceNeedsAttention,
  sessionMaintenanceReasons,
} from "@cardigan/domain";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ExecutionAssignment, ExecutionData, RunView } from "../api.js";
import type { ExecutionGroup } from "../execution-display.js";
import {
  assignmentMachine,
  machineLabel,
  runMachine,
} from "../execution-machine.js";
import { assignmentActivity } from "../execution-sort.js";
import { routeHash } from "../route.js";
import { statusLabel } from "../status.js";
import { useBoardPan } from "../useBoardPan.js";
import { DetailsTip } from "./DetailsTip.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { IdTag, LongContent, StatusTag, Time } from "./Foundation.js";
import { IdentityRow } from "./IdentityRow.js";
import { IdBadge } from "./IdTag.js";
import { BoardCardLayout } from "./layout/BoardCardLayout.js";
import { CardLink } from "./Operations.js";
import { PriorityBadge } from "./Priority.js";
import { Tooltip } from "./Tooltip.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { MoreHorizontalIcon } from "./ui/icons.js";
import { TableCell, TableRow } from "./ui/table.js";

export const MachinesContext = createContext<ExecutionData["machines"]>([]);
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
export function AssignmentMachine({
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
export const unfinished = (run: RunView) =>
  !["completed", "failed", "cancelled"].includes(run.status);
const runStatus = (run: RunView) =>
  run.failure_reason ??
  (run.queue_reason === "provider_unavailable"
    ? run.queue_reason
    : (run.outcome ?? run.status));
const runKind = (run: RunView) => kinds[run.kind] ?? "执行";
const runTime = (run: RunView) =>
  run.finished_at ?? run.started_at ?? run.queued_at;
export function RunSummary({ text }: { readonly text: string }) {
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
    run.queue_reason === "provider_unavailable"
      ? "等待模型服务恢复后自动重派"
      : "",
    runStatus(run) === "provider_unavailable" && run.launch_profile_ref
      ? `启动配置：${run.launch_profile_ref}`
      : "",
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
    abnormalRun(run) ? `最近执行：${statusLabel(runStatus(run))}` : "",
  ];
}
export function RunLine({ run }: { readonly run: RunView }) {
  const details = useRunDetails(run);
  return (
    <>
      <IdTag id={run.id} label={runKind(run)} />
      <DetailsTip lines={[statusLabel(runStatus(run)), ...details]}>
        <Button variant="ghost" className="ui-status-tip">
          <StatusTag status={runStatus(run)} />
        </Button>
      </DetailsTip>
      <MachineBadge id={runMachine(run)} />
      {runTime(run) && <Time value={runTime(run)} />}
    </>
  );
}
const NONE = "—";
/** C-106: the Harness; unknown or missing shows "—". */
export function runHarness(run: RunView | undefined): string {
  if (!run?.harness) return NONE;
  return isHarness(run.harness)
    ? HARNESS_CATALOG[run.harness].displayName
    : run.harness;
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
export const labelledStandingRoles = new Set(["pm", "host_ops"]);
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
          <StatusTag status={runStatus(run)} />
        )}
        {run && abnormalRun(run) && <StatusTag status={runStatus(run)} />}
        {a.status !== "active" && a.status !== a.runtime_state && (
          <StatusTag status={a.status} />
        )}
      </Button>
    </DetailsTip>
  );
}

export function MaintenanceReason({
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
  return value ? <Time value={value} /> : <span className="hint">—</span>;
}
/** Clicks on the row's own links and buttons do their own thing. */
const interactive = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("a, button, input, select, textarea, summary") !== null;
export interface RowProps {
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
export function AssignmentRow({
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
        <IdentityRow className="execution-state">
          <RuntimeState a={a} run={run} />
        </IdentityRow>
      </TableCell>
      <TableCell data-column="machine">
        <AssignmentMachine a={a} />
      </TableCell>
      <TableCell data-column="context">
        <ContextCell run={run} />
      </TableCell>
      <TableCell data-column="config" className="execution-config">
        <LongContent lines={2}>{runConfig(run)}</LongContent>
      </TableCell>
      <TableCell data-column="activity">
        <Activity value={assignmentActivity(a, run)} />
      </TableCell>
    </TableRow>
  );
}
/** C-207: the same Assignment as a card below 760px; DOM order = reading order. */
export function AssignmentCard({
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
            <Tooltip content="运行配置与最近执行">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="execution-card-more"
                aria-label="运行配置与最近执行"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded(!expanded)}
              >
                <MoreHorizontalIcon aria-hidden="true" />
              </Button>
            </Tooltip>
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
export function useNarrow() {
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

export function GroupLabel({ group }: { readonly group: ExecutionGroup }) {
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
    </IdentityRow>
  );
}

export function GroupHeading({
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
export function EmployeeLanes({
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
