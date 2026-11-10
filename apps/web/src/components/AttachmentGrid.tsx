import type { AttachmentView } from "../api.js";
import { AttachmentCaption, attachmentName } from "./AttachmentCaption.js";
import { AttachmentPreview, isBitmap } from "./AttachmentPreview.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { StatusTag, Time } from "./Foundation.js";
import { splitSuperseded } from "./Timeline.js";

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;
function Gallery({ attachments }: { attachments: readonly AttachmentView[] }) {
  const images = attachments.filter(isBitmap);
  return (
    <ul className="attachment-grid">
      {attachments.map((a) => (
        <li key={a.id} id={`attachment-${a.id}`}>
          {isBitmap(a) ? (
            <AttachmentPreview attachment={a} images={images} />
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
          <AttachmentCaption attachment={a} />
          <EmployeeIdentity
            {...a}
            author={a.uploaded_by}
            author_role={a.uploader_role}
            showTitle={false}
          />
          <Time value={a.uploaded_at} />
          <span>{size(a.size)}</span>
          {a.basis && (
            <span>
              依据 {a.basis.id}（<StatusTag status={a.basis.status} />）
            </span>
          )}
          <a href={a.download_path} download>
            下载 {attachmentName(a)}
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
