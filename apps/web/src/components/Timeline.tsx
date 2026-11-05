// biome-ignore-all lint/security/noDangerouslySetInnerHtml: every HTML string
// here comes from `renderMarkdown` (markdown-it with html off and a link
// allow-list), never from the entry body itself.
import type { AttachmentView } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { linkifyReferences } from "../refs.js";

/**
 * The card's timeline (M5 plan §3.7, §8.4 of the development plan).
 *
 * Entries are typed, and each type gets its own label and look so a decision is
 * not mistaken for a comment. The body is Markdown written by a human or an
 * Agent: it goes through the sanitising renderer, and identifiers only become
 * links through the entry's server-provided `refs`.
 */

const TYPE_LABELS: Readonly<Record<string, string>> = {
  comment: "评论",
  instruction: "指令",
  delivery: "交付",
  review: "审核",
  decision_request: "决策请求",
  decision_resolved: "决策结果",
  human_action: "待你执行",
  handoff: "交接",
  status_change: "状态变化",
  system: "系统",
};

const DECISION_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: "待批",
  provisional: "临时",
  resolved: "已批",
  withdrawn: "已撤回",
  superseded: "已取代",
  revoked: "已撤销",
  unknown: "状态未知",
};

export function decisionStatusLabel(status: string): string {
  return DECISION_STATUS_LABELS[status] ?? status;
}

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
  readonly entries: readonly import("../api.js").TimelineEntryView[];
  readonly attachments: readonly AttachmentView[];
}

export function Timeline({ projectId, entries, attachments }: TimelineProps) {
  if (entries.length === 0) {
    return <p className="empty">还没有时间线条目。</p>;
  }
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
            <div className="timeline-head">
              <span className="timeline-type">
                {TYPE_LABELS[entry.type] ?? entry.type}
              </span>
              <span className="timeline-author">
                {authorLabel(entry.author)}
              </span>
              <time dateTime={entry.created_at}>
                {entry.created_at.replace("T", " ").replace(/\..*$/u, "")}
              </time>
              <span className="timeline-seq">#{entry.event_seq}</span>
              {entry.retracted && (
                <span className="timeline-retracted">已撤回</span>
              )}
            </div>
            <div
              className="timeline-body markdown"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(
                  linkifyReferences(entry.body, entry.refs, projectId),
                ),
              }}
            />
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
      <span className="attachment-id">{attachment.id}</span>
      <span className="attachment-basis">
        {attachment.basis === null
          ? "无拍板依据"
          : `依据 ${attachment.basis.id}（${decisionStatusLabel(attachment.basis.status)}）`}
      </span>
    </li>
  );
}
