import {
  sessionMaintenanceNeedsAttention,
  sessionMaintenanceReasons,
} from "@cardigan/domain";
import { type ReactNode, useContext, useEffect, useState } from "react";
import type {
  CardiganClient,
  ExecutionAssignment,
  ExecutionRunPage,
  RunView,
} from "../api.js";
import { assignmentMachine, runMachine } from "../execution-machine.js";
import { assignmentActivity } from "../execution-sort.js";
import { routeHash } from "../route.js";
import { statusLabel } from "../status.js";
import {
  AssignmentMachine,
  contextReading,
  MachineBadge,
  MachinesContext,
  MaintenanceReason,
  meterTones,
  RunStatus,
  runHarness,
  runKind,
  runTime,
  standingLabel,
  unfinished,
  windowSize,
} from "./ExecutionContent.js";
import { IdTag, StatusTag, Time, useNow } from "./Foundation.js";
import {
  CardDetailLayout,
  DetailCommand,
  DetailCommandList,
  DetailDisclosure,
  DetailFact,
  DetailFacts,
  DetailHistoryItem,
  DetailHistoryList,
  DetailMuted,
  DetailNextStep,
  DetailNextStepFact,
  DetailNextStepLine,
  DetailSection,
  DetailStatusRow,
  detailHistoryTextClassName,
} from "./layout/CardDetailLayout.js";
import { Menu, type MenuItem } from "./Menu.js";
import { cliCommand, TakeoverWarning } from "./Operations.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Tooltip } from "./Tooltip.js";
import { Button, IconButton } from "./ui/button.js";
import { ChevronRightIcon, CopyIcon } from "./ui/icons.js";
import { Meter } from "./ui/meter.js";
import { MoreButton } from "./ui/more-button.js";

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
function useRunHistory(
  client: CardiganClient,
  projectId: string,
  assignmentId: string,
  revision: number,
) {
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
  return { state, error, loadingMore, more };
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

/** C-702: one line per Run (C-687 §4.5); the full summary is on hover. */
function RunRecords({
  a,
  history,
}: {
  readonly a: ExecutionAssignment;
  readonly history: ReturnType<typeof useRunHistory>;
}) {
  const machines = useContext(MachinesContext);
  const home = assignmentMachine(a, machines);
  const { state, error, loadingMore, more } = history;
  return (
    <DetailSection title="执行记录" count={state?.total || undefined}>
      {error && <p role="alert">读取执行记录失败：{error}</p>}
      {state === undefined ? (
        !error && <DetailMuted>正在读取…</DetailMuted>
      ) : state.runs.length === 0 ? (
        <DetailMuted>没有执行记录</DetailMuted>
      ) : (
        <>
          <DetailHistoryList aria-label={`${a.id} 执行记录`}>
            {state.runs.map((entry) => (
              <DetailHistoryItem
                key={entry.id}
                lead={
                  <>
                    <IdTag id={entry.id} label={runKind(entry)} />
                    <RunStatus run={entry} />
                    {runMachine(entry) && runMachine(entry) !== home && (
                      <MachineBadge id={runMachine(entry)} />
                    )}
                  </>
                }
                time={runTime(entry) && <Time value={runTime(entry)} />}
              >
                <RunSummaryLine text={entry.summary} />
              </DetailHistoryItem>
            ))}
          </DetailHistoryList>
          {state.next && (
            <Button type="button" disabled={loadingMore} onClick={more}>
              {loadingMore ? "正在读取…" : "显示更多"}
            </Button>
          )}
        </>
      )}
    </DetailSection>
  );
}
function RunSummaryLine({ text }: { readonly text: string }) {
  const summary = text.trim();
  if (!summary) return <DetailMuted>—</DetailMuted>;
  return (
    <Tooltip
      scrollable
      content={<div className="ui-tooltip-details">{summary}</div>}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the full summary must be reachable by keyboard. */}
      <span className={detailHistoryTextClassName} tabIndex={0}>
        {summary}
      </span>
    </Tooltip>
  );
}

const CURSOR_PAGE = 10;
/** C-75/C-702: 签收 folds into one fact; expanded, newest sequence first. */
function useCursors(a: ExecutionAssignment) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(CURSOR_PAGE);
  const cursors = [...a.cursors].sort(
    (left, right) => right.acked_seq - left.acked_seq,
  );
  const summary =
    cursors.length === 0 ? (
      "—"
    ) : (
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {cursors.length} 张卡片，最新序号 {cursors[0]?.acked_seq ?? 0}
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    );
  const list = open && cursors.length > 0 && (
    <>
      <DetailHistoryList aria-label={`${a.id} 签收`}>
        {cursors.slice(0, shown).map((cursor) => (
          <DetailHistoryItem
            key={cursor.card_id}
            lead={<IdTag id={cursor.card_id} label="卡片" />}
          >
            已签收序号 {cursor.acked_seq}
          </DetailHistoryItem>
        ))}
      </DetailHistoryList>
      {cursors.length > shown && (
        <Button type="button" onClick={() => setShown(shown + CURSOR_PAGE)}>
          显示更多
        </Button>
      )}
    </>
  );
  return { summary, list };
}

function useCopy() {
  const [message, setMessage] = useState("");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("已复制");
    } catch {
      setMessage("复制失败，请选中命令手动复制。");
    }
  };
  return { copy, feedback: <RequestFeedback message={message} /> };
}
function CopyIconButton({
  label,
  onCopy,
}: {
  readonly label: string;
  readonly onCopy: () => void;
}) {
  return (
    <Tooltip content={label}>
      <IconButton variant="ghost" aria-label={label} onClick={onCopy}>
        <CopyIcon aria-hidden="true" />
      </IconButton>
    </Tooltip>
  );
}

/** C-702: what the panel says about the Assignment, most urgent first. */
export type ExecutionState =
  | "external"
  | "released"
  | "suspended"
  | "lost"
  | "running"
  | "maintenance"
  | "idle";
export function executionState(
  a: ExecutionAssignment,
  live: boolean,
): ExecutionState {
  if (a.external) return "external";
  if (a.status === "released" || a.runtime_state === "released")
    return "released";
  if (a.status === "suspended") return "suspended";
  const maintenance = a.session_maintenance;
  if (
    ["lost", "unknown"].includes(a.runtime_state) ||
    maintenance?.reason === "agent_exited"
  )
    return "lost";
  if (live || a.runtime_state === "running") return "running";
  // An idle candidate is routine: the session stays idle until it is checked.
  if (
    maintenance &&
    maintenance.reason !== "idle_candidate" &&
    sessionMaintenanceNeedsAttention(maintenance.reason)
  )
    return "maintenance";
  return "idle";
}
const stateStatus = (a: ExecutionAssignment, state: ExecutionState) =>
  state === "running" || state === "released" || state === "suspended"
    ? state
    : state === "lost" && a.runtime_state !== "unknown"
      ? "lost"
      : a.runtime_state;

const duration = (from: string | undefined, now: number) => {
  const start = from ? Date.parse(from) : Number.NaN;
  if (!Number.isFinite(start)) return undefined;
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} 小时${rest ? ` ${rest} 分钟` : ""}`;
  }
  return `${Math.floor(minutes / 1440)} 天`;
};

/** The facts under the panel title, joined by a muted middle dot. */
function Facts({ items }: { readonly items: readonly ReactNode[] }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <DetailNextStepLine>
      {shown.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed short list.
        <DetailNextStepFact key={index}>
          {index > 0 && <span aria-hidden="true">·</span>}
          {item}
        </DetailNextStepFact>
      ))}
    </DetailNextStepLine>
  );
}
/** A Run as 编号 + 类型 + 状态, after an optional lead-in. */
const runRef = (run: RunView | undefined, prefix?: string) =>
  run && (
    <>
      {prefix && <span>{prefix}</span>}
      <IdTag id={run.id} label={runKind(run)} />
      <RunStatus run={run} />
    </>
  );

export function ExecutionDetail({
  a,
  run,
  live,
  roleName,
  client,
  projectId,
  revision,
}: {
  readonly a: ExecutionAssignment;
  readonly run: RunView | undefined;
  readonly live: boolean;
  /** C-262: the role's display name, for the standing-label fallback. */
  readonly roleName?: string | undefined;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly revision: number;
}) {
  const now = useNow();
  const history = useRunHistory(client, projectId, a.id, revision);
  const cursors = useCursors(a);
  const { copy, feedback } = useCopy();
  const state = executionState(a, live);
  const latest = run ?? history.state?.runs[0];
  const activity = assignmentActivity(a, latest);
  const reading = contextReading(latest);
  const maintenance = a.session_maintenance;
  const maintenanceLabel = maintenance
    ? sessionMaintenanceReasons[maintenance.reason]
    : undefined;
  const needsYou = routeHash({ kind: "needs-you", projectId });
  const cardHref = a.card_id
    ? routeHash({ kind: "card", projectId, cardId: a.card_id })
    : undefined;

  // C-702: the commands and their display conditions are unchanged; they
  // move into the folded 命令行 section.
  const attach = cliCommand(projectId, "assignment attach", a.id);
  const attachable = !a.external && a.status === "active" && !!a.runtime_ref;
  const startable =
    !a.external &&
    a.status === "active" &&
    !live &&
    ["idle", "not_provisioned"].includes(a.runtime_state) &&
    !["done", "cancelled", "awaiting_merge"].includes(a.card_status ?? "");
  const stoppable = attachable && live;
  const commands = [
    attachable && { label: "在 Herdr 中查看（只看）", command: attach },
    attachable && {
      label: "接管输入",
      command: `${attach} --interactive`,
      takeover: true,
    },
    startable && {
      label: "启动或恢复会话",
      command: cliCommand(projectId, "assignment start", a.id),
    },
    stoppable && {
      label: "停止终端并取消当前执行",
      command: cliCommand(projectId, "assignment stop", a.id),
    },
    {
      label: "查看收件箱",
      command: cliCommand(projectId, "inbox --assignment", a.id),
    },
    a.worktree_path && {
      label: "查看改动",
      command: cliCommand(projectId, "worktree diff", a.id),
    },
    { label: "检查异常", command: cliCommand(projectId, "attention") },
  ].filter(
    (item): item is { label: string; command: string; takeover?: boolean } =>
      !!item,
  );

  const menu: MenuItem[] = [
    ...(attachable
      ? [
          {
            id: "copy-attach",
            label: "复制接入命令",
            onSelect: () => void copy(attach),
          },
        ]
      : []),
    {
      id: "needs-you",
      label: "在 Needs You 中查看",
      onSelect: () => {
        window.location.hash = needsYou;
      },
    },
  ];

  const copyAttach = attachable && (
    <Button type="button" size="regular" onClick={() => void copy(attach)}>
      <CopyIcon aria-hidden="true" />
      复制接入命令
    </Button>
  );
  const openCard = cardHref && (
    <Button asChild size="regular">
      <a href={cardHref}>打开卡片</a>
    </Button>
  );
  const panel: Record<
    ExecutionState,
    { title: ReactNode; facts: ReactNode[]; actions?: ReactNode }
  > = {
    running: {
      title: (
        <>
          正在执行
          {latest && unfinished(latest) && (
            <IdTag id={latest.id} label={runKind(latest)} />
          )}
        </>
      ),
      facts: [
        latest &&
          unfinished(latest) &&
          duration(latest.started_at, now) &&
          `已运行 ${duration(latest.started_at, now)}`,
        reading && `上下文 ${Math.round(reading.meter)}%`,
      ],
      actions: copyAttach,
    },
    idle: {
      title:
        a.runtime_state === "not_provisioned"
          ? "尚未启动会话"
          : a.runtime_state === "provisioning"
            ? "正在启动会话"
            : "空闲，等新消息",
      facts: [
        runRef(latest, "上次执行"),
        a.runtime_state === "idle" &&
          duration(activity, now) &&
          `空闲 ${duration(activity, now)}`,
      ],
      actions: startable && (
        <Button
          type="button"
          size="regular"
          onClick={() =>
            void copy(cliCommand(projectId, "assignment start", a.id))
          }
        >
          <CopyIcon aria-hidden="true" />
          复制启动命令
        </Button>
      ),
    },
    maintenance: {
      title: `会话维护中：${maintenanceLabel ?? ""}`,
      facts: [runRef(latest, "上次执行")],
      actions: copyAttach,
    },
    lost: {
      title: maintenanceLabel ? `会话失联：${maintenanceLabel}` : "会话失联",
      facts: [
        runRef(latest),
        duration(activity, now) && `${duration(activity, now)}没有活动`,
      ],
      actions: (
        <Button asChild size="regular">
          <a href={needsYou}>到 Needs You 处理</a>
        </Button>
      ),
    },
    suspended: {
      title: "已暂停",
      facts: [runRef(latest, "上次执行")],
    },
    released: {
      title: "已释放",
      facts: [
        a.card_status &&
          ["done", "cancelled"].includes(a.card_status) &&
          `卡片${statusLabel(a.card_status)}`,
        runRef(latest, "最后一次执行"),
      ],
      actions: openCard,
    },
    external: {
      title: "由对接的 Agent 自行拉取",
      facts: [],
      actions: openCard,
    },
  };
  const current = panel[state];

  return (
    <CardDetailLayout className="execution-drawer card-page-drawer">
      <DetailStatusRow
        aria-label="执行状态"
        actions={
          <Menu
            label="更多执行操作"
            trigger={<MoreButton label="更多执行操作" />}
            items={menu}
          />
        }
      >
        {state === "external" ? (
          <span>外接身份</span>
        ) : (
          <StatusTag status={stateStatus(a, state)} />
        )}
        {a.card_id ? (
          <IdTag
            id={a.card_id}
            label={a.card_title ?? "卡片"}
            href={cardHref}
          />
        ) : (
          <span>{standingLabel(a, roleName)}</span>
        )}
        {activity && (
          <DetailMuted>
            最近活动 <Time value={activity} />
          </DetailMuted>
        )}
      </DetailStatusRow>
      <DetailNextStep
        aria-label="当前"
        title={current.title}
        mine={state === "lost"}
        actions={current.actions || undefined}
      >
        <Facts items={current.facts} />
      </DetailNextStep>

      <DetailSection title="运行环境">
        <DetailFacts columns={2}>
          <DetailFact label="运行工具">{runHarness(latest)}</DetailFact>
          <DetailFact label="模型">
            {latest?.model || "—"}
            {latest?.model && latest.effort && (
              <DetailMuted>推理强度 {latest.effort}</DetailMuted>
            )}
          </DetailFact>
          <DetailFact label="上下文">
            {reading ? (
              <Meter
                value={reading.meter}
                tone={meterTones[reading.level]}
                label={`上下文已用 ${reading.used}%`}
              >
                {Math.round(reading.meter)}%{" "}
                <DetailMuted>
                  {windowSize(reading.usedTokens)} / {reading.window}
                </DetailMuted>
              </Meter>
            ) : (
              "—"
            )}
          </DetailFact>
          <DetailFact label="机器">
            <AssignmentMachine a={a} plain />
          </DetailFact>
          <DetailFact label="会话" code>
            {a.session_ref ?? "—"}
          </DetailFact>
          <DetailFact label="终端" code>
            {a.runtime_ref?.terminal_ref ?? "—"}
          </DetailFact>
          <DetailFact label="分支" code>
            {a.branch ?? "—"}
          </DetailFact>
          <DetailFact
            label="工作目录"
            code
            truncate={a.worktree_path ?? undefined}
            actions={
              a.worktree_path && (
                <CopyIconButton
                  label="复制工作目录"
                  onCopy={() => void copy(a.worktree_path ?? "")}
                />
              )
            }
          >
            {a.worktree_path ?? "—"}
          </DetailFact>
        </DetailFacts>
      </DetailSection>

      <DetailSection title="会话维护">
        <DetailFacts columns={2}>
          {maintenance && (
            <>
              <DetailFact label="当前判断">
                <MaintenanceReason a={a} projectId={projectId} detail />
                {maintenance.candidate && <DetailMuted>空闲候选</DetailMuted>}
              </DetailFact>
              <DetailFact label="空闲阈值">
                {maintenance.threshold_minutes} 分钟
              </DetailFact>
              <DetailFact label="最近评估">
                <Time value={maintenance.evaluated_at} />
              </DetailFact>
            </>
          )}
          <DetailFact label="签收">{cursors.summary}</DetailFact>
        </DetailFacts>
        {cursors.list}
      </DetailSection>

      <RunRecords a={a} history={history} />

      <DetailDisclosure title="命令行" count={commands.length}>
        {attachable && <TakeoverWarning />}
        <DetailCommandList aria-label={`${a.id} 命令`}>
          {commands.map((item) => (
            <DetailCommand
              key={item.label}
              label={item.label}
              command={item.command}
              action={
                <CopyIconButton
                  label={`复制${item.label}`}
                  onCopy={() => void copy(item.command)}
                />
              }
            />
          ))}
        </DetailCommandList>
      </DetailDisclosure>
      {feedback}
    </CardDetailLayout>
  );
}
