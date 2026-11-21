import { useState } from "react";
import type { AttachmentView } from "../api.js";
import { AttachmentCaption, attachmentName } from "./AttachmentCaption.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { Lightbox } from "./Lightbox.js";
import { ImageUnavailableIcon } from "./ui/icons.js";

export const isBitmap = (a: AttachmentView) =>
  a.inline && /^image\/(png|jpeg|gif|webp|avif)$/i.test(a.mime);

export function AttachmentPreview({
  attachment,
  images,
}: {
  attachment: AttachmentView;
  images: readonly AttachmentView[];
}) {
  const initial = images.findIndex((image) => image.id === attachment.id);
  const [open, setOpen] = useState(false),
    [index, setIndex] = useState(initial),
    // C-540: a thumbnail that fails to load shows the placeholder, not a blank box.
    [failed, setFailed] = useState<string | null>(null),
    thumbnail = attachment.thumbnail_path;
  return (
    <Lightbox
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setIndex(initial);
      }}
      index={index}
      onIndexChange={setIndex}
      images={images.map((a) => ({
        src: a.download_path,
        alt: `附件 ${attachmentName(a)}`,
        caption: (
          <>
            <AttachmentCaption attachment={a} />
            <EmployeeIdentity
              {...a}
              author={a.uploaded_by}
              author_role={a.uploader_role}
              showTitle={false}
            />{" "}
            <a href={a.download_path} download>
              下载
            </a>
          </>
        ),
      }))}
      trigger={
        <button
          type="button"
          className="attachment-preview"
          aria-label={`预览 ${attachmentName(attachment)}`}
        >
          {thumbnail && failed !== thumbnail ? (
            <img
              src={thumbnail}
              alt={`附件 ${attachmentName(attachment)}`}
              loading="lazy"
              onError={() => setFailed(thumbnail)}
            />
          ) : (
            <ImageUnavailableIcon />
          )}
        </button>
      }
    />
  );
}
