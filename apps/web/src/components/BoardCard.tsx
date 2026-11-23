import type { MouseEvent, ReactNode } from "react";
import type { CardListItem } from "../api.js";
import {
  cardChecking,
  MERGE_CHECK_LABEL,
  PRECHECK_LABEL,
} from "../card-checking.js";
import type { CardDisplay } from "../card-display.js";
import { routeHash } from "../route.js";
import { nextOwnersLabel } from "../status.js";
import { CardHoldTip, CardMergeTip, CardStatusTip } from "./CardStatusTip.js";
import { DetailsTip } from "./DetailsTip.js";
import { ProduceOwners } from "./EmployeeIdentity.js";
import { fullTime, Time } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import {
  BoardCardSignal,
  type BoardCardSignalKind,
} from "./layout/BoardCardLayout.js";
import boardCardStyles from "./layout/BoardCardLayout.module.css";
import { MergeBatchCard } from "./layout/MergeBatchLayout.js";
import { highlightBatch } from "./MergeBatch.js";
import { PriorityBadge } from "./Priority.js";
import { StatusIcon } from "./StatusIcon.js";
import { TemplateMarker } from "./TemplateMarker.js";
import { Tooltip } from "./Tooltip.js";

const paths = {
  roles:
    "M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 17v-2a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v2m1-13a3 3 0 0 1 0 6m1 2a4 4 0 0 1 4 4v1",
  next: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM1 17v-2a4 4 0 0 1 4-4h2m4 0h7m-3-3 3 3-3 3",
  clock: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3v5l3 2",
  attachment: "m7 11 6-6a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l7-7m-5 11 7-7",
  review_phase: "M3 5h1m3 0h10M3 10h1m3 0h10M3 15h1m3 0h10",
  reason: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 6v6m0-9v.1",
} as const;

export function BoardCardIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function ProgressPie({ completed, total }: CardListItem["progress"]) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
  const angle = ratio * Math.PI * 2;
  return (
    <svg className="board-progress" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" />
      {ratio === 1 ? (
        <circle cx="10" cy="10" r="8" fill="currentColor" />
      ) : ratio > 0 ? (
        <path
          d={`M10 10 L10 2 A8 8 0 ${ratio > 0.5 ? 1 : 0} 1 ${10 + 8 * Math.sin(angle)} ${10 - 8 * Math.cos(angle)} Z`}
          fill="currentColor"
        />
      ) : null}
    </svg>
  );
}

/** C-660: corner tag text, in priority order (阻塞 first). */
export const BOARD_CARD_SIGNALS = [
  { kind: "blocked", text: "阻塞" },
  { kind: "decision", text: "待拍板" },
  { kind: "human_action", text: "待人工" },
  { kind: "closeout", text: "待结案" },
] as const satisfies readonly { kind: BoardCardSignalKind; text: string }[];

/** Review-pause phases that wait for someone to close out and resume. */
const CLOSEOUT_PHASES: ReadonlySet<string> = new Set([
  "待你结案恢复",
  "待 PM 结案恢复",
]);

/**
 * C-660: every blocked/waiting reason as one tooltip line per kind, highest
 * priority first. A blocker that only waits for a running precheck is not
 * listed (C-567); ordinary review phases keep their own metadata badge.
 */
export function boardCardSignals(
  card: Pick<CardListItem, "waiting_on" | "checking">,
) {
  const waiting = cardChecking(card).waiting;
  return BOARD_CARD_SIGNALS.map(({ kind, text }) => {
    const items = waiting.filter((item) =>
      kind === "closeout"
        ? !!item.review_phase && CLOSEOUT_PHASES.has(item.review_phase)
        : !item.review_phase && item.kind === kind,
    );
    return {
      kind,
      text,
      line: items.length
        ? `${text}：${items.map((item) => item.label).join("；")}`
        : "",
    };
  }).filter((signal) => signal.line);
}

/**
 * Read-only card navigation; employee profile buttons are siblings of links.
 * When adding/changing signals, update CardLegend and its coverage test (C-410).
 */
export function BoardCard({
  card,
  projectId,
  display,
  onOpenCard,
}: {
  card: CardListItem;
  projectId: string;
  display: CardDisplay;
  onOpenCard?: ((cardId: string, trigger: HTMLElement) => void) | undefined;
}) {
  const href = routeHash({ kind: "card", projectId, cardId: card.id });
  const openCard = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      !onOpenCard ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onOpenCard(card.id, event.currentTarget);
  };
  // C-567: a blocker that only waits for a running precheck is not red.
  const checks = cardChecking(card);
  const signals = boardCardSignals(card);
  const signal = signals[0];
  const complete =
    card.progress.total > 0 && card.progress.completed === card.progress.total;
  const queuedAhead = card.queued_runs?.length
    ? Math.min(...card.queued_runs.map((run) => run.ahead))
    : null;
  const superseded =
    card.resolution === "superseded"
      ? card.superseded_by
        ? `已被 ${card.superseded_by} 取代`
        : "已被取代"
      : null;
  function badge(label: string, icon: ReactNode, text?: ReactNode, tone = "") {
    return (
      <Tooltip key={label} content={label}>
        <a
          className={`board-card-badge ${tone}`}
          href={href}
          onClick={openCard}
          aria-label={label}
        >
          {icon}
          {text}
        </a>
      </Tooltip>
    );
  }
  return (
    <MergeBatchCard
      batchColor={
        card.merge_stage?.batch_id ? (card.merge_stage.color ?? 0) : undefined
      }
      data-batch-id={card.merge_stage?.batch_id}
      onMouseEnter={(e) => highlightBatch(e.currentTarget, true)}
      onMouseLeave={(e) => highlightBatch(e.currentTarget, false)}
      className={`${boardCardStyles.card} card-tile board-card ui-surface-card${superseded ? " card-superseded" : ""}`}
    >
      <span className="card-tile-head ui-inline-items">
        {display.number && (
          <span className="card-id">
            <IdBadge id={card.id} />
          </span>
        )}
        <CardStatusTip card={card} />
      </span>
      <Tooltip content={card.title}>
        <a className="card-tile-link" href={href} onClick={openCard}>
          <span className="card-title">{card.title}</span>
        </a>
      </Tooltip>
      <TemplateMarker card={card} info={card.template_info} />
      <CardHoldTip card={card} />
      <div className="board-card-meta ui-inline-items">
        <CardMergeTip card={card} projectId={projectId} />
        <PriorityBadge value={card.priority} />
        {display.progress &&
          badge(
            `进度：${card.progress.completed}/${card.progress.total}${complete ? "，全部完成" : ""}`,
            <ProgressPie {...card.progress} />,
            `${card.progress.completed}/${card.progress.total}`,
            complete ? "board-card-complete" : "",
          )}
        {queuedAhead !== null &&
          badge(
            queuedAhead === 0
              ? "即将开始"
              : `排队中（前面还有 ${queuedAhead} 个）`,
            <StatusIcon status="queued" decorative />,
            queuedAhead,
          )}
        <ProduceOwners
          owners={card.participants ?? card.produce_owners ?? []}
          label="参与员工"
          presence
        />
        {display.roles &&
          badge(
            `负责角色：${card.roles.join("、") || "尚未配置"}`,
            <BoardCardIcon name="roles" />,
          )}
        {display.next &&
          badge(
            `下一步：${nextOwnersLabel(card.next_owners)}`,
            <BoardCardIcon name="next" />,
          )}
        {(display.updated || !!card.attachment_count) && (
          <span className="board-card-time-attachments">
            {display.updated &&
              badge(
                `更新时间：${fullTime(card.updated_at)}`,
                <BoardCardIcon name="clock" />,
                <Time value={card.updated_at} relative />,
              )}
            {!!card.attachment_count &&
              badge(
                `附件：${card.attachment_count} 个`,
                <BoardCardIcon name="attachment" />,
                card.attachment_count,
              )}
          </span>
        )}
        {display.waiting &&
          checks.waiting
            .filter(
              (item) =>
                item.review_phase && !CLOSEOUT_PHASES.has(item.review_phase),
            )
            .map((item) =>
              badge(
                item.label,
                <BoardCardIcon name="review_phase" />,
                item.review_phase,
                "review-phase-badge",
              ),
            )}
        {display.waiting &&
          checks.precheck &&
          badge(
            PRECHECK_LABEL,
            <StatusIcon status="running" decorative />,
            PRECHECK_LABEL,
          )}
        {display.waiting &&
          checks.mergeCheck &&
          badge(
            MERGE_CHECK_LABEL,
            <StatusIcon status="running" decorative />,
            MERGE_CHECK_LABEL,
          )}
        {superseded &&
          badge(
            superseded,
            <StatusIcon status="superseded" decorative />,
            <span className="visually-hidden">{superseded}</span>,
          )}
        {display.reason &&
          badge(`原因：${card.why}`, <BoardCardIcon name="reason" />)}
        {signal && (
          <DetailsTip lines={signals.map(({ line }) => line)}>
            <BoardCardSignal
              kind={signal.kind}
              href={href}
              onClick={openCard}
              aria-label={signals.map(({ line }) => line).join("。")}
            >
              {signal.text}
            </BoardCardSignal>
          </DetailsTip>
        )}
      </div>
    </MergeBatchCard>
  );
}
