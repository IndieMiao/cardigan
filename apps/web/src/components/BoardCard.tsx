import type { MouseEvent, ReactNode } from "react";
import type { CardListItem } from "../api.js";
import type { CardDisplay } from "../card-display.js";
import { routeHash } from "../route.js";
import { nextOwnersLabel } from "../status.js";
import { ProduceOwners } from "./EmployeeIdentity.js";
import { fullTime, StatusTag, Time } from "./Foundation.js";
import { StatusIcon } from "./StatusIcon.js";
import { Tooltip } from "./Tooltip.js";

const paths = {
  roles:
    "M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 17v-2a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v2m1-13a3 3 0 0 1 0 6m1 2a4 4 0 0 1 4 4v1",
  next: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM1 17v-2a4 4 0 0 1 4-4h2m4 0h7m-3-3 3 3-3 3",
  clock: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3v5l3 2",
  attachment: "m7 11 6-6a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l7-7m-5 11 7-7",
  human_action:
    "M5 9V5a1 1 0 0 1 2 0v4-6a1 1 0 0 1 2 0v6-5a1 1 0 0 1 2 0v5-3a1 1 0 0 1 2 0v6l2-2a1 1 0 0 1 2 2l-4 5H7L3 12a1 1 0 0 1 2-1l2 2",
  reason: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 6v6m0-9v.1",
} as const;

function Icon({ name }: { name: keyof typeof paths }) {
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

function ProgressPie({ completed, total }: CardListItem["progress"]) {
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

/** Read-only card navigation; employee profile buttons are siblings of links. */
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
  const reasons = new Set(card.waiting_on.map((item) => item.kind));
  const blocked = reasons.has("blocked");
  const waiting = reasons.has("decision") || reasons.has("human_action");
  const complete =
    card.progress.total > 0 && card.progress.completed === card.progress.total;
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
          title={label}
        >
          {icon}
          {text}
        </a>
      </Tooltip>
    );
  }
  return (
    <div
      className={`card-tile board-card${blocked ? " card-tile-blocked" : waiting ? " card-tile-waiting" : ""}${superseded ? " card-superseded" : ""}`}
    >
      <Tooltip content={card.title}>
        <a className="card-tile-link" href={href} onClick={openCard}>
          <span className="card-tile-head">
            {display.number && (
              <span className="card-id" title={`卡片 ${card.id}`}>
                {card.id}
              </span>
            )}
            <StatusTag status={card.status} />
          </span>
          <span className="card-title" title={card.title}>
            {card.title}
          </span>
        </a>
      </Tooltip>
      {card.queued_runs?.map((run) => (
        <p
          className="hint"
          key={run.run_id}
          title={`${run.assignment_id} / ${run.run_id}`}
        >
          排队中（前面还有 {run.ahead} 个）
        </p>
      ))}
      <div className="board-card-meta">
        {display.progress &&
          badge(
            `进度：${card.progress.completed}/${card.progress.total}${complete ? "，全部完成" : ""}`,
            <ProgressPie {...card.progress} />,
            `${card.progress.completed}/${card.progress.total}`,
            complete ? "board-card-complete" : "",
          )}
        <ProduceOwners
          owners={card.participants ?? card.produce_owners ?? []}
          label="参与员工"
        />
        {display.roles &&
          badge(
            `负责角色：${card.roles.join("、") || "尚未配置"}`,
            <Icon name="roles" />,
          )}
        {display.next &&
          badge(
            `下一步：${nextOwnersLabel(card.next_owners)}`,
            <Icon name="next" />,
          )}
        {display.updated &&
          badge(
            `更新时间：${fullTime(card.updated_at)}`,
            <Icon name="clock" />,
            <Time value={card.updated_at} relative />,
          )}
        {!!card.attachment_count &&
          badge(
            `附件：${card.attachment_count} 个`,
            <Icon name="attachment" />,
            card.attachment_count,
          )}
        {display.waiting &&
          (["decision", "human_action", "blocked"] as const)
            .filter((kind) => reasons.has(kind))
            .map((kind) => {
              const label = {
                decision: "等你拍板",
                human_action: "待你执行",
                blocked: "阻塞",
              }[kind];
              return badge(
                `${label}：${card.waiting_on
                  .filter((item) => item.kind === kind)
                  .map((item) => item.label)
                  .join("；")}`,
                kind === "human_action" ? (
                  <Icon name={kind} />
                ) : (
                  <StatusIcon
                    status={kind === "blocked" ? "blocked" : "waiting_decision"}
                    decorative
                  />
                ),
                <span className="visually-hidden">{label}</span>,
                kind === "blocked"
                  ? "board-card-blocked"
                  : "board-card-waiting",
              );
            })}
        {superseded &&
          badge(
            superseded,
            <StatusIcon status="superseded" decorative />,
            <span className="visually-hidden">{superseded}</span>,
          )}
        {display.reason && badge(`原因：${card.why}`, <Icon name="reason" />)}
      </div>
    </div>
  );
}
