import { useState } from "react";
import type { AttachmentView } from "../api.js";
import { AttachmentCaption, attachmentName } from "./AttachmentCaption.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { Lightbox } from "./Lightbox.js";
import { AttachmentThumb } from "./layout/AttachmentTileLayout.js";
import { ImageUnavailableIcon } from "./ui/icons.js";

export const isBitmap = (a: AttachmentView) =>
  a.inline && /^image\/(png|jpeg|gif|webp|avif)$/i.test(a.mime);

export function AttachmentPreview({
  attachment,
  images,
  compact = false,
}: {
  attachment: AttachmentView;
  images: readonly AttachmentView[];
  /** A small square in a line of text (a system line's upload). */
  compact?: boolean;
}) {
  const initial = images.findIndex((image) => image.id === attachment.id);
  const [open, setOpen] = useState(false),
    [index, setIndex] = useState(initial),
    // C-540: a thumbnail that fails to load shows the placeholder, not a blank box.
    // C-614: the first failure retries the locally rendered thumbnail, since
    // the server may have redirected to an off-site copy the browser cannot reach.
    [failed, setFailed] = useState<string | null>(null),
    [local, setLocal] = useState(false),
    thumbnail =
      attachment.thumbnail_path &&
      (local
        ? `${attachment.thumbnail_path}?local=1`
        : attachment.thumbnail_path);
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
        src: a.preview_path ?? a.download_path,
        ...(a.preview_path ? { fallbackSrc: `${a.preview_path}?local=1` } : {}),
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
        <AttachmentThumb
          compact={compact}
          aria-label={`预览 ${attachmentName(attachment)}`}
        >
          {thumbnail && failed !== thumbnail ? (
            <img
              src={thumbnail}
              alt={`附件 ${attachmentName(attachment)}`}
              loading="lazy"
              onError={() => (local ? setFailed(thumbnail) : setLocal(true))}
            />
          ) : (
            <ImageUnavailableIcon />
          )}
        </AttachmentThumb>
      }
    />
  );
}
