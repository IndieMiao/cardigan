import type { ReactNode } from "react";
import type { AttachmentView } from "../api.js";
import { attachmentName } from "./AttachmentCaption.js";
import { AttachmentPreview, isBitmap } from "./AttachmentPreview.js";

/**
 * §6/§9 C-95: card attachments a decision references. Bitmaps show as
 * thumbnails that open the shared lightbox; other files are a name and a
 * download link. Both use the authenticated attachment route. C-810: `more`
 * (“还有 N 个”) follows the last one.
 */
export function DecisionAttachments({
  attachments,
  more,
}: {
  attachments: readonly AttachmentView[] | undefined;
  more?: ReactNode;
}) {
  if (!attachments?.length && !more) return null;
  const images = (attachments ?? []).filter(isBitmap);
  return (
    <ul className="decision-attachments" aria-label="拍板附件">
      {attachments?.map((a) => (
        <li key={a.id}>
          {isBitmap(a) ? (
            <AttachmentPreview attachment={a} images={images} />
          ) : (
            <a
              className="decision-attachment-file"
              href={a.download_path}
              download
            >
              ▤ {attachmentName(a)}
            </a>
          )}
        </li>
      ))}
      {more && <li>{more}</li>}
    </ul>
  );
}
