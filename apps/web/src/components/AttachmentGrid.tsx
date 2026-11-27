import type { AttachmentView } from "../api.js";
import { attachmentRefKind, formatBytes } from "../attachment-refs.js";
import { attachmentName } from "./AttachmentCaption.js";
import { AttachmentPreview, isBitmap } from "./AttachmentPreview.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { StatusTag, Time } from "./Foundation.js";
import {
  AttachmentFileMark,
  AttachmentTile,
  AttachmentTileGrid,
} from "./layout/AttachmentTileLayout.js";
import { FileKindIcon } from "./ui/file-chip.js";
import { isVideo, VideoPreview } from "./VideoPreview.js";

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

const hasPreview = (a: AttachmentView) => isBitmap(a) || isVideo(a);

/** Short type name of a file without a preview. */
export function fileTypeLabel(mime: string): string {
  const type = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "text/markdown") return "Markdown";
  if (type === "text/plain") return "文本";
  if (type === "application/pdf") return "PDF";
  if (type === "application/json") return "JSON";
  if (/^text\/(x-)?(patch|diff)$/.test(type)) return "补丁";
  return type;
}

/**
 * C-820: one attachment as the shared tile — thumbnail or type strip, name,
 * uploader avatar, time, size and a two-line note. `basis="always"` also
 * says when the file rests on no decision (the timeline's comments).
 */
function AttachmentCard({
  attachment: a,
  images,
  basis,
  anchor,
}: {
  attachment: AttachmentView;
  images: readonly AttachmentView[];
  basis: "shown" | "always";
  anchor: boolean;
}) {
  const kind = attachmentRefKind(a.mime, a.inline);
  return (
    <AttachmentTile
      id={anchor ? `attachment-${a.id}` : undefined}
      attachmentId={a.id}
      kind={hasPreview(a) ? "media" : "file"}
      media={
        isBitmap(a) ? (
          <AttachmentPreview attachment={a} images={images} />
        ) : isVideo(a) ? (
          <VideoPreview attachment={a} />
        ) : (
          <AttachmentFileMark
            icon={<FileKindIcon kind={kind === "image" ? "file" : kind} />}
            label={fileTypeLabel(a.mime)}
          />
        )
      }
      name={attachmentName(a)}
      meta={
        <>
          <EmployeeIdentity
            {...a}
            author={a.uploaded_by}
            author_role={a.uploader_role}
            avatarOnly
            avatarSize={24}
          />
          <Time value={a.uploaded_at} />
          <span>{formatBytes(a.size)}</span>
        </>
      }
      note={a.note}
      download={a.download_path}
      footer={
        a.basis ? (
          <>
            依据 {a.basis.id}（<StatusTag status={a.basis.status} />）
          </>
        ) : basis === "always" ? (
          "无拍板依据"
        ) : undefined
      }
    />
  );
}

/**
 * C-820: the attachment grid of the attachments tab, the timeline and a
 * decision. Files with a preview come first; the lightbox steps through the
 * images in that order.
 */
export function AttachmentList({
  attachments,
  label,
  basis = "shown",
  flow = false,
  anchor = false,
}: {
  attachments: readonly AttachmentView[];
  label?: string;
  basis?: "shown" | "always";
  /** Inside a timeline entry or a decision: space above and below. */
  flow?: boolean;
  /** The attachments tab: each tile is the `attachment-<id>` anchor. */
  anchor?: boolean;
}) {
  const sorted = [
    ...attachments.filter(hasPreview),
    ...attachments.filter((a) => !hasPreview(a)),
  ];
  const images = sorted.filter(isBitmap);
  return (
    <AttachmentTileGrid label={label} flow={flow}>
      {sorted.map((a) => (
        <AttachmentCard
          key={a.id}
          attachment={a}
          images={images}
          basis={basis}
          anchor={anchor}
        />
      ))}
    </AttachmentTileGrid>
  );
}

export function AttachmentGrid({
  attachments,
}: {
  attachments: readonly AttachmentView[];
}) {
  const { current, superseded } = splitSuperseded(attachments);
  return (
    <>
      <AttachmentList attachments={current} anchor />
      {!!superseded.length && (
        <details>
          <summary>已取代的附件（{superseded.length}）</summary>
          <AttachmentList attachments={superseded} anchor />
        </details>
      )}
    </>
  );
}
