import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { percent } from "./imageZoom.js";
import {
  LightboxPicture,
  LightboxViewport,
  LightboxZoomBar,
} from "./layout/LightboxLayout.js";
import * as Dialog from "./ui/dialog.js";
import { useImageZoom } from "./useImageZoom.js";

export interface LightboxImage {
  readonly src: string;
  /** Loaded instead when `src` fails, e.g. the local copy of an OSS image. */
  readonly fallbackSrc?: string;
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

/**
 * Fullscreen image preview with arrow-key and button navigation. C-830: the
 * image zooms (buttons, wheel or trackpad, double click or tap, pinch) and
 * pans by dragging; a click on blank space closes it, the end of a drag
 * does not.
 */
export function Lightbox({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  trigger,
}: LightboxProps) {
  const current = images[index];
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const source =
    current &&
    (failed.has(current.src) && current.fallbackSrc
      ? current.fallbackSrc
      : current.src);
  const zoom = useImageZoom(source);
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
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "+" || event.key === "=") zoom.zoomIn();
            if (event.key === "-") zoom.zoomOut();
            if (event.key === "0") zoom.fit();
          }}
          onClick={(event) => {
            if (zoom.consumeDrag(event)) return;
            const target = event.target as Element;
            if (
              target === event.currentTarget ||
              target.hasAttribute("data-lightbox-blank")
            )
              onOpenChange(false);
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
            <LightboxViewport
              ref={zoom.stage}
              pannable={zoom.pannable}
              dragging={zoom.dragging}
              {...zoom.stageHandlers}
            >
              {current && (
                <LightboxPicture
                  src={source}
                  alt={current.alt}
                  view={zoom.view}
                  natural={zoom.natural}
                  onLoad={zoom.onImageLoad}
                  onError={() =>
                    setFailed((previous) => new Set(previous).add(current.src))
                  }
                />
              )}
            </LightboxViewport>
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
          {current && (
            <LightboxZoomBar
              value={zoom.view ? percent(zoom.view) : "—"}
              atMin={zoom.atMin}
              atMax={zoom.atMax}
              onZoomOut={zoom.zoomOut}
              onZoomIn={zoom.zoomIn}
              onFit={zoom.fit}
              onActualSize={() => zoom.actualSize()}
            />
          )}
          <p className="lightbox-caption" data-lightbox-blank="">
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
