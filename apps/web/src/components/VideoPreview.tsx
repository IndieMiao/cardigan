import { useState } from "react";
import type { AttachmentView } from "../api.js";
import { formatBytes } from "../attachment-refs.js";
import { AttachmentCaption, attachmentName } from "./AttachmentCaption.js";
import { Button } from "./ui/button.js";
import * as Dialog from "./ui/dialog.js";
import { VideoTile } from "./ui/video-tile.js";

/** C-683: a video attachment (with or without a cover frame). */
export const isVideo = (a: AttachmentView) => a.video !== undefined;

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * C-683: a video in the timeline: its cover frame with duration and size;
 * a click plays it with the browser's own player (never automatically).
 * `compact` rows (system lines) show the frame only.
 */
export function VideoPreview({
  attachment,
  compact = false,
}: {
  attachment: AttachmentView;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = attachmentName(attachment);
  const seconds = attachment.video?.duration_seconds;
  const duration = seconds === undefined ? undefined : formatDuration(seconds);
  const facts = [duration, formatBytes(attachment.size)]
    .filter(Boolean)
    .join(" · ");
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <VideoTile
          className="attachment-preview"
          poster={attachment.poster_path}
          alt={`视频 ${name}`}
          facts={compact ? undefined : facts}
          aria-label={`播放 ${name}`}
        />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="lightbox-overlay" />
        <Dialog.Content
          className="lightbox-content"
          aria-describedby={undefined}
        >
          <Dialog.Title className="visually-hidden">{`视频 ${name}`}</Dialog.Title>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              className="quiet lightbox-close"
              aria-label="关闭播放"
            >
              关闭
            </Button>
          </Dialog.Close>
          <div className="lightbox-stage">
            {open && (
              // biome-ignore lint/a11y/useMediaCaption: user uploads carry no caption track.
              <video
                className="lightbox-image"
                src={attachment.download_path}
                controls
                preload="metadata"
                poster={attachment.poster_path}
              />
            )}
          </div>
          <p className="lightbox-caption">
            <span>
              <AttachmentCaption attachment={attachment} /> {facts}{" "}
              <a href={attachment.download_path} download>
                下载
              </a>
            </span>
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
