import { type ReactElement, type ReactNode, useEffect } from "react";
import * as Dialog from "./ui/dialog.js";

export interface LightboxImage {
  readonly src: string;
  readonly alt: string;
  readonly caption?: ReactNode;
}

export interface LightboxProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly images: readonly LightboxImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly trigger?: ReactElement;
}

/** Fullscreen image preview with arrow-key and button navigation. */
export function Lightbox({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  trigger,
}: LightboxProps) {
  const current = images[index];
  /**
   * §9 U6a: a preview dims the whole viewport, so the page records it and the
   * drawer drops its own mask instead of stacking two of them.
   */
  useEffect(() => {
    if (!open) return;
    const body = document.body,
      previous = body.getAttribute("data-lightbox");
    body.setAttribute("data-lightbox", "open");
    return () => {
      if (previous === null) body.removeAttribute("data-lightbox");
      else body.setAttribute("data-lightbox", previous);
    };
  }, [open]);
  const move = (delta: number) => {
    if (images.length === 0) return;
    onIndexChange((index + delta + images.length) % images.length);
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="lightbox-overlay" />
        <Dialog.Content
          className="lightbox-content"
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") move(-1);
            if (event.key === "ArrowRight") move(1);
          }}
        >
          <Dialog.Title className="visually-hidden">
            {current?.alt ?? "图片预览"}
          </Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              className="quiet lightbox-close"
              aria-label="关闭预览"
            >
              关闭
            </button>
          </Dialog.Close>
          <div className="lightbox-stage">
            {current && (
              <img
                className="lightbox-image"
                src={current.src}
                alt={current.alt}
              />
            )}
            {images.length > 1 && (
              <>
                <button
                  type="button"
                  className="lightbox-nav previous"
                  aria-label="上一张"
                  onClick={() => move(-1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="lightbox-nav next"
                  aria-label="下一张"
                  onClick={() => move(1)}
                >
                  ›
                </button>
              </>
            )}
          </div>
          <p className="lightbox-caption">
            <span>{current?.caption ?? current?.alt ?? "没有图片"}</span>
            {images.length > 0 && (
              <span>
                {index + 1} / {images.length}
              </span>
            )}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
