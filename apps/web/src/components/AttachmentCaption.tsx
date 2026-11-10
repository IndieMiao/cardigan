import type { AttachmentView } from "../api.js";

export const attachmentName = (attachment: AttachmentView) =>
  attachment.original_filename || attachment.id;

export function AttachmentCaption({
  attachment,
}: {
  attachment: AttachmentView;
}) {
  return (
    <span className="attachment-caption">
      <strong>{attachmentName(attachment)}</strong>
      {attachment.note && <span>{attachment.note}</span>}
    </span>
  );
}
