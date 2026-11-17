import { WHY_MAX_LENGTH } from "@cardigan/domain";
import type { ReactElement } from "react";
import type { CardListItem, MergeStageView } from "../api.js";
import { routeHash } from "../route.js";
import { dependencyWaitLabel } from "./CardDependencies.js";
import { StatusTag } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import { mergeStageLabel } from "./MergeBatch.js";
import { Tooltip } from "./Tooltip.js";
import { Button } from "./ui/button.js";

function DetailsTip({
  lines,
  children,
}: {
  lines: readonly string[];
  children: ReactElement;
}) {
  return (
    <Tooltip
      side="bottom"
      scrollable
      content={
        <div className="ui-tooltip-details">
          {[...new Set(lines.filter(Boolean))].map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      }
    >
      {children}
    </Tooltip>
  );
}

/** Card summaries expose read-model facts without rendering explanation blocks. */
export function CardStatusTip({ card }: { card: CardListItem }) {
  const wait = dependencyWaitLabel(card);
  const lines = [
    ...(wait ? [wait, card.early_start?.reason ?? ""] : []),
    ...card.waiting_on.map((item) => item.label),
    ...(card.merge_stage ? [mergeStageLabel(card.merge_stage)] : []),
    ...(card.merge_solo ? ["单独批次"] : []),
  ];
  // The read model caps why; prefer its complete source when it is available.
  // Short identifiers can share a prefix (C-1 / C-10) without being redundant.
  const capped = Array.from(card.why).length === WHY_MAX_LENGTH;
  if (
    card.why &&
    !lines.some(
      (line) => line === card.why || (capped && line.startsWith(card.why)),
    )
  )
    lines.unshift(card.why);
  if (!lines.some(Boolean)) return <StatusTag status={card.status} />;
  return (
    <DetailsTip lines={lines}>
      <Button variant="ghost" className="ui-status-tip" data-card-status-tip="">
        <StatusTag status={card.status} />
      </Button>
    </DetailsTip>
  );
}

export function CardHoldTip({ card }: { card: CardListItem }) {
  if (!card.hold) return null;
  return (
    <DetailsTip
      lines={[
        `原因：${card.hold.reason}`,
        `恢复条件：${card.hold.resume_condition}`,
      ]}
    >
      <Button variant="ghost" className="ui-status-tip card-hold-tag">
        已暂停
      </Button>
    </DetailsTip>
  );
}

const mergeLabels: Record<MergeStageView["stage"], string> = {
  awaiting_confirmation: "待确认",
  queued: "排队中",
  held_by_window: "等待合并窗口",
  batch_checking: "批次检查中",
  bisecting: "二分定位中",
  culprit: "定位为失败原因",
  merged_in_batch: "已随批次合并",
};
export function CardMergeTip({
  card,
  projectId,
}: {
  card: CardListItem;
  projectId: string;
}) {
  const stage = card.merge_stage;
  if (!stage && !card.merge_solo) return null;
  const content = (
    <>
      {stage?.batch_id && <IdBadge id={stage.batch_id} />}
      {stage ? mergeLabels[stage.stage] : "单独批次"}
    </>
  );
  const lines = [
    ...(stage ? [mergeStageLabel(stage)] : []),
    ...(card.merge_solo ? ["单独批次"] : []),
  ];
  return (
    <DetailsTip lines={lines}>
      {stage?.batch_id ? (
        <Button
          asChild
          variant="ghost"
          className="ui-status-tip"
          data-failed={stage.stage === "culprit" || undefined}
        >
          <a
            href={routeHash({
              kind: "merge-batch",
              projectId,
              batchId: stage.batch_id,
            })}
          >
            {content}
          </a>
        </Button>
      ) : (
        <Button variant="ghost" className="ui-status-tip">
          {content}
        </Button>
      )}
    </DetailsTip>
  );
}

export function CardSupersededTip({ card }: { card: CardListItem }) {
  if (card.resolution !== "superseded") return null;
  return (
    <DetailsTip
      lines={[
        card.superseded_by ? `已被 ${card.superseded_by} 取代` : "已被取代",
      ]}
    >
      <Button variant="ghost" className="ui-status-tip">
        <StatusTag status="superseded" />
      </Button>
    </DetailsTip>
  );
}
