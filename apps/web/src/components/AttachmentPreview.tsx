import { useState } from "react";
import type { AttachmentView } from "../api.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { Lightbox } from "./Lightbox.js";

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
    [index, setIndex] = useState(initial);
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
        alt: `附件 ${a.id}`,
        caption: (
          <>
            {a.id}{" "}
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
          aria-label={`预览 ${attachment.id}`}
        >
          <img
            src={attachment.download_path}
            alt={`附件 ${attachment.id}`}
            loading="lazy"
          />
        </button>
      }
    />
  );
}
