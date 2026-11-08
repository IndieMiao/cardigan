import { useState } from "react";
import type { AttachmentView } from "../api.js";
import { statusLabel } from "../status.js";
import { Time } from "./Foundation.js";
import { Lightbox } from "./Lightbox.js";
import { splitSuperseded } from "./Timeline.js";

const bitmap = (a: AttachmentView) =>
  a.inline && /^image\/(png|jpeg|gif|webp|avif)$/i.test(a.mime);
const uploader = (a: AttachmentView) =>
  a.uploaded_by === "human"
    ? "你"
    : a.uploaded_by.startsWith("assignment:")
      ? `${a.uploader_role ?? "Agent"} ${a.uploaded_by.slice(11)}`
      : "系统";
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;
function Preview({
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
            {a.id} {uploader(a)}{" "}
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
function Gallery({ attachments }: { attachments: readonly AttachmentView[] }) {
  const images = attachments.filter(bitmap);
  return (
    <ul className="attachment-grid">
      {attachments.map((a) => (
        <li key={a.id} id={`attachment-${a.id}`}>
          {bitmap(a) ? (
            <Preview attachment={a} images={images} />
          ) : (
            <div
              className="attachment-file"
              role="img"
              aria-label={`${a.mime} 文件`}
            >
              ▤{" "}
              <span>
                {a.mime === "text/markdown"
                  ? "Markdown"
                  : a.mime === "text/plain"
                    ? "文本"
                    : a.mime}
              </span>
            </div>
          )}
          <strong>{a.id}</strong>
          <span>{uploader(a)}</span>
          <Time value={a.uploaded_at} />
          <span>{size(a.size)}</span>
          {a.basis && (
            <span>
              依据 {a.basis.id}（{statusLabel(a.basis.status)}）
            </span>
          )}
          <a href={a.download_path} download>
            下载 {a.id}
          </a>
        </li>
      ))}
    </ul>
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
      <Gallery attachments={current} />
      {!!superseded.length && (
        <details>
          <summary>已取代的附件（{superseded.length}）</summary>
          <Gallery attachments={superseded} />
        </details>
      )}
    </>
  );
}
