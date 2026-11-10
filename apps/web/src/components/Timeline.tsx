// biome-ignore-all lint/security/noDangerouslySetInnerHtml: every HTML string
// here comes from `renderMarkdown` (markdown-it with html off and a link
// allow-list), never from the entry body itself.
import type { AttachmentView, CardDetail, TimelineEntryView } from "../api.js";
import { eventLabel } from "../events.js";
import { renderMarkdown } from "../markdown.js";
import { linkableReferences, linkifyReferences } from "../refs.js";
import { statusLabel } from "../status.js";
import { AttachmentCaption, attachmentName } from "./AttachmentCaption.js";
import { AttachmentPreview, isBitmap } from "./AttachmentPreview.js";
import { EmptyState, LongContent, Time } from "./Foundation.js";
import { TimelineContent } from "./TimelineContent.js";
import {
  TimelineActor,
  TimelineHeader,
  TimelineIcon,
} from "./TimelineHeader.js";

/**
 * The card's timeline (M5 plan §3.7, §8.4 of the development plan).
 *
 * Entries are typed, and each type gets its own label and look so a decision is
 * not mistaken for a comment. The body is Markdown written by a human or an
 * Agent: it goes through the sanitising renderer, and identifiers only become
 * links through the entry's server-resolved `references` with `exists: true`.
 */

const TYPE_LABELS: Readonly<Record<string, string>> = {
  comment: "评论",
  instruction: "指令",
  delivery: "交付",
  review: "审核",
  decision_request: "请求拍板",
  decision_resolved: "拍板结果",
  human_action: "待你执行",
  handoff: "交接",
  status_change: "状态变化",
  system: "系统",
};

export const decisionStatusLabel = statusLabel;

/** `assignment:A-1` → `A-1`; `human` → 你; `system` → 系统. */
export function authorLabel(author: string): string {
  if (author === "human") return "你";
  if (author === "system") return "系统";
  return author.startsWith("assignment:")
    ? author.slice("assignment:".length)
    : author;
}

/** Split current attachments from the ones a newer upload replaced. */
export function splitSuperseded(attachments: readonly AttachmentView[]): {
  readonly current: readonly AttachmentView[];
  readonly superseded: readonly AttachmentView[];
} {
  const replaced = new Set(
    attachments.flatMap((attachment) =>
      attachment.supersedes === null ? [] : [attachment.supersedes],
    ),
  );
  return {
    current: attachments.filter((attachment) => !replaced.has(attachment.id)),
    superseded: attachments.filter((attachment) => replaced.has(attachment.id)),
  };
}

export interface TimelineProps {
  readonly projectId: string;
  readonly cardId: string;
  readonly entries: readonly import("../api.js").TimelineEntryView[];
  readonly attachments: readonly AttachmentView[];
  readonly detail?: CardDetail;
  readonly typeFilter?: string;
  readonly authorFilter?: string;
  readonly anchor?: string | undefined;
}

export const timelineCategory = (entry: TimelineEntryView) =>
  entry.type.startsWith("decision_")
    ? "decision"
    : ["system", "status_change"].includes(entry.type)
      ? "system"
      : entry.type;
export const timelineAuthor = (entry: TimelineEntryView) =>
  entry.author === "human"
    ? "human"
    : entry.author === "system"
      ? "system"
      : entry.author_role === "pm"
        ? "pm"
        : "agent";
const timelineAliases = (entry: TimelineEntryView) =>
  [
    entry.delivery_id && `delivery-${entry.delivery_id}`,
    entry.review_id && `review-${entry.review_id}`,
    entry.decision_id && `decision-${entry.decision_id}`,
    entry.human_action_id && `human-action-${entry.human_action_id}`,
  ].filter((id): id is string => Boolean(id));

export const targetsEntry = (entry: TimelineEntryView, anchor?: string) =>
  anchor !== undefined &&
  (anchor === `entry-${entry.id}` || timelineAliases(entry).includes(anchor));

function timelineDay(entry: TimelineEntryView) {
  const date = new Date(entry.created_at);
  if (!Number.isFinite(date.getTime()))
    return { key: "unknown", label: "日期未知" };
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    label: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date),
  };
}

/** Group before filtering: hidden comments must not make separated system rows consecutive. */
export function timelineGroups(entries: readonly TimelineEntryView[]) {
  const groups: TimelineEntryView[][] = [];
  for (const entry of [...entries].sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      b.event_seq - a.event_seq,
  )) {
    const last = groups.at(-1),
      previous = last?.at(-1);
    if (
      previous &&
      timelineDay(entry).key === timelineDay(previous).key &&
      timelineCategory(entry) === "system" &&
      timelineCategory(previous) === "system" &&
      entry.event_type &&
      entry.event_type === previous.event_type &&
      entry.author === previous.author &&
      !entry.retracted &&
      !previous.retracted
    )
      last?.push(entry);
    else groups.push([entry]);
  }
  return groups;
}
export function Timeline({
  projectId,
  cardId,
  entries,
  attachments,
  detail,
  typeFilter = "",
  authorFilter = "",
  anchor,
}: TimelineProps) {
  const groups = timelineGroups(entries)
    .map((group) =>
      group.filter(
        (entry) =>
          ((!typeFilter || timelineCategory(entry) === typeFilter) &&
            (!authorFilter || timelineAuthor(entry) === authorFilter)) ||
          targetsEntry(entry, anchor),
      ),
    )
    .filter((group) => group.length);
  if (!groups.length)
    return (
      <EmptyState>
        {entries.length
          ? "没有符合筛选条件的条目。调整筛选后继续查看。"
          : "还没有时间线条目。评论、交付和审核会记录在这里。"}
      </EmptyState>
    );
  // Entity links belong to their earliest event (the server's anchor-window
  // contract), not the first displayed result/review in a newest-first list.
  const aliasRows = new Map<string, TimelineEntryView>();
  for (const entry of groups.flat()) {
    for (const id of timelineAliases(entry)) {
      const owner = aliasRows.get(id);
      if (!owner || entry.event_seq < owner.event_seq) aliasRows.set(id, entry);
    }
  }
  const row = (entry: TimelineEntryView, nested = false) => {
    const related = attachments.filter(
      (a) =>
        (a.attach_to.kind === "timeline_entry" &&
          a.attach_to.id === entry.id) ||
        (entry.type === "delivery" &&
          a.attach_to.kind === "delivery" &&
          a.attach_to.id === entry.delivery_id),
    );
    const { current, superseded } = splitSuperseded(related);
    const structured =
      detail &&
      ((entry.type === "delivery" &&
        detail.deliveries.some((d) => d.id === entry.delivery_id)) ||
        (entry.type === "review" &&
          detail.reviews.some((r) => r.id === entry.review_id)) ||
        (entry.type.startsWith("decision_") &&
          detail.decisions.some((d) => d.id === entry.decision_id)));
    return (
      <li
        className={`timeline-entry timeline-${entry.type}${["delivery", "review", "decision"].includes(timelineCategory(entry)) ? " timeline-record" : ""}${entry.retracted ? " timeline-retracted" : ""}`}
        key={entry.id}
        id={`entry-${entry.id}`}
        data-timeline-type={entry.type}
      >
        {!nested && <TimelineIcon entry={entry} />}
        {timelineAliases(entry).map((id) =>
          aliasRows.get(id)?.id === entry.id ? (
            <span key={id} id={id} className="anchor-target" />
          ) : null,
        )}
        {structured && detail ? (
          <TimelineContent
            entry={entry}
            detail={detail}
            projectId={projectId}
            cardId={cardId}
          />
        ) : (
          <>
            <TimelineHeader
              entry={entry}
              action={TYPE_LABELS[entry.type] ?? "系统记录"}
            />
            <LongContent
              lines={["comment", "instruction"].includes(entry.type) ? 15 : 6}
            >
              <div
                className="timeline-body markdown"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(
                    linkifyReferences(
                      entry.body,
                      linkableReferences(entry.references ?? []),
                      projectId,
                      cardId,
                    ),
                  ),
                }}
              />
            </LongContent>
          </>
        )}
        {!!current.length && (
          <ul className="attachments">
            {current.map((attachment) => (
              <AttachmentItem key={attachment.id} attachment={attachment} />
            ))}
          </ul>
        )}
        {!!superseded.length && (
          <details className="superseded">
            <summary>已取代的附件（{superseded.length}）</summary>
            <ul className="attachments">
              {superseded.map((attachment) => (
                <AttachmentItem key={attachment.id} attachment={attachment} />
              ))}
            </ul>
          </details>
        )}
      </li>
    );
  };
  const days = new Map<
    string,
    { label: string; groups: TimelineEntryView[][] }
  >();
  for (const group of groups) {
    const first = group[0];
    if (!first) continue;
    const day = timelineDay(first);
    if (!days.has(day.key)) days.set(day.key, { label: day.label, groups: [] });
    days.get(day.key)?.groups.push(group);
  }
  return (
    <div className="timeline-days">
      {[...days].map(([key, day]) => (
        <section
          className="timeline-day"
          key={key}
          aria-label={`${day.label}时间线`}
        >
          <h3>{day.label}</h3>
          <ol className="timeline">
            {day.groups.map((group) => {
              const first = group[0];
              if (!first) return null;
              if (timelineCategory(first) !== "system") return row(first);
              const label =
                first.event_type === "assignment_released" && group.length > 1
                  ? `释放了 ${group.length} 个 Assignment`
                  : `${eventLabel(first.event_type ?? "")}${group.length > 1 ? `（${group.length} 条）` : ""}`;
              const uploaded = attachments.filter((a) =>
                group.some((entry) => entry.attachment_id === a.id),
              );
              const images = uploaded.filter(isBitmap);
              const hasDetails =
                group.length > 1 ||
                group.some(
                  (entry) =>
                    entry.retracted ||
                    (entry.body.trim() &&
                      ![
                        entry.event_type,
                        eventLabel(entry.event_type ?? ""),
                      ].includes(entry.body.trim())),
                );
              return (
                <li
                  className={`system-group${hasDetails ? "" : " timeline-entry"}`}
                  key={first.id}
                  id={hasDetails ? undefined : `entry-${first.id}`}
                >
                  <TimelineIcon entry={first} />
                  <div className="system-line">
                    <TimelineActor entry={first} compact />
                    <span>{label}</span>
                    <Time value={first.created_at} relative />
                    {uploaded.map((a) => (
                      <span className="attachment-caption" key={a.id}>
                        {isBitmap(a) ? (
                          <AttachmentPreview attachment={a} images={images} />
                        ) : (
                          <a href={a.download_path} download>
                            下载 {attachmentName(a)}
                          </a>
                        )}
                        <AttachmentCaption attachment={a} />
                      </span>
                    ))}
                  </div>
                  {hasDetails && (
                    <details className="system-details">
                      <summary>
                        详情{group.length > 1 ? `（${group.length}）` : ""}
                      </summary>
                      <ol>{group.map((entry) => row(entry, true))}</ol>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/**
 * An attachment: a bitmap may render inline, everything else is a download
 * (§3.2). The caption carries the decision it rests on, so a screenshot without
 * an approved basis is visible as such.
 */
function AttachmentItem({
  attachment,
}: {
  readonly attachment: AttachmentView;
}) {
  return (
    <li className="attachment">
      {isBitmap(attachment) ? (
        <AttachmentPreview attachment={attachment} images={[attachment]} />
      ) : (
        <a
          className="attachment-download"
          href={attachment.download_path}
          rel="noopener noreferrer"
        >
          下载 {attachmentName(attachment)}（{attachment.mime}）
        </a>
      )}
      <AttachmentCaption attachment={attachment} />
      <span className="attachment-basis">
        {attachment.basis === null
          ? "无拍板依据"
          : `依据 ${attachment.basis.id}（${decisionStatusLabel(attachment.basis.status)}）`}
      </span>
    </li>
  );
}
