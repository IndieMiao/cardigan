// biome-ignore-all lint/security/noDangerouslySetInnerHtml: every HTML string
// here comes from `renderMarkdown` (markdown-it with html off and a link
// allow-list), never from the entry body itself.
import type { AttachmentView } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { linkableReferences, linkifyReferences } from "../refs.js";
import { statusLabel } from "../status.js";
import { EmptyState, IdTag, LongContent, Time } from "./Foundation.js";

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

function attachmentFor(
  entryId: string,
  attachments: readonly AttachmentView[],
): readonly AttachmentView[] {
  return attachments.filter(
    (attachment) =>
      attachment.attach_to.kind === "timeline_entry" &&
      attachment.attach_to.id === entryId,
  );
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
}

export function Timeline({
  projectId,
  cardId,
  entries,
  attachments,
}: TimelineProps) {
  if (entries.length === 0) {
    return (
      <EmptyState>还没有时间线条目。评论、交付和审核会记录在这里。</EmptyState>
    );
  }
  const seenAnchors = new Set<string>();
  /** One alias per referenced delivery/human action, at its first timeline row. */
  const alias = (prefix: string, id: string | undefined) => {
    if (id === undefined) return null;
    const anchor = `${prefix}-${id}`;
    if (seenAnchors.has(anchor)) return null;
    seenAnchors.add(anchor);
    return <span key={anchor} id={anchor} className="anchor-target" />;
  };
  return (
    <ol className="timeline">
      {entries.map((entry) => {
        const all = attachmentFor(entry.id, attachments);
        const { current, superseded } = splitSuperseded(all);
        return (
          <li
            className={`timeline-entry timeline-${entry.type}${entry.retracted ? " timeline-retracted" : ""}`}
            key={entry.id}
            id={`entry-${entry.id}`}
            data-timeline-type={entry.type}
          >
            {alias("delivery", entry.delivery_id)}
            {alias("human-action", entry.human_action_id)}
            <div className="timeline-head">
              <span className="timeline-type">
                {TYPE_LABELS[entry.type] ?? "系统记录"}
              </span>
              <span className="timeline-author">
                {entry.author.startsWith("assignment:") ? (
                  <IdTag id={authorLabel(entry.author)} label="Agent" />
                ) : (
                  authorLabel(entry.author)
                )}
              </span>
              <Time value={entry.created_at} />
              <span className="timeline-seq">序号 {entry.event_seq}</span>
              {entry.retracted && (
                <span className="timeline-retracted">已撤回</span>
              )}
            </div>
            <LongContent>
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
            {current.length > 0 && (
              <ul className="attachments">
                {current.map((attachment) => (
                  <AttachmentItem key={attachment.id} attachment={attachment} />
                ))}
              </ul>
            )}
            {superseded.length > 0 && (
              <details className="superseded">
                <summary>已取代的附件（{superseded.length}）</summary>
                <ul className="attachments">
                  {superseded.map((attachment) => (
                    <AttachmentItem
                      key={attachment.id}
                      attachment={attachment}
                    />
                  ))}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ol>
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
      {attachment.inline ? (
        <img
          className="attachment-thumb"
          src={attachment.download_path}
          alt={`附件 ${attachment.id}`}
          loading="lazy"
        />
      ) : (
        <a
          className="attachment-download"
          href={attachment.download_path}
          rel="noopener noreferrer"
        >
          下载 {attachment.id}（{attachment.mime}）
        </a>
      )}
      <IdTag id={attachment.id} label="附件" detail={attachment.mime} />
      <span className="attachment-basis">
        {attachment.basis === null
          ? "无拍板依据"
          : `依据 ${attachment.basis.id}（${decisionStatusLabel(attachment.basis.status)}）`}
      </span>
    </li>
  );
}
