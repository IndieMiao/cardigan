import {
  type ComponentProps,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils.js";
import type { View } from "../imageZoom.js";
import { Tooltip } from "../Tooltip.js";
import { IconButton } from "../ui/button.js";
import { FitIcon, ZoomInIcon, ZoomOutIcon } from "../ui/icons.js";
import styles from "./LightboxLayout.module.css";

/**
 * C-830: the area of the image preview that zooms and pans. It fills the
 * preview's stage; a press on it outside the image counts as blank space
 * (`data-lightbox-blank`), which closes the preview.
 */
export const LightboxViewport = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    /** The image is larger than the viewport: show the grab cursor. */
    pannable?: boolean;
    dragging?: boolean;
  }
>(({ pannable = false, dragging = false, className, ...props }, ref) => (
  <div
    {...props}
    ref={ref}
    className={cn(styles.viewport, className)}
    data-lightbox-blank=""
    data-pannable={pannable ? "" : undefined}
    data-dragging={dragging ? "" : undefined}
  />
));
LightboxViewport.displayName = "LightboxViewport";

/**
 * The previewed image. Without a `view` (size not known yet) it is fitted by
 * CSS; with one it is placed at the view's scale and offset.
 */
export function LightboxPicture({
  view,
  natural,
  className,
  ...props
}: ComponentProps<"img"> & {
  view: View | null;
  natural: { width: number; height: number } | null;
}) {
  const placed = view && natural;
  return (
    // biome-ignore lint/a11y/useAltText: alt arrives through props.
    <img
      {...props}
      className={cn(styles.picture, placed && styles.placed, className)}
      draggable={false}
      style={
        placed
          ? {
              width: natural.width * view.scale,
              height: natural.height * view.scale,
              transform: `translate(${view.x}px, ${view.y}px)`,
            }
          : undefined
      }
    />
  );
}

/** Zoom out / current scale / zoom in, then fit and 100%. */
export function LightboxZoomBar({
  value,
  atMin,
  atMax,
  onZoomOut,
  onZoomIn,
  onFit,
  onActualSize,
}: {
  value: ReactNode;
  atMin: boolean;
  atMax: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onActualSize: () => void;
}) {
  // aria-disabled keeps focus on a button that reaches its limit.
  const limit = (reached: boolean) =>
    reached
      ? ({ "aria-disabled": true, "data-disabled": "" } as const)
      : undefined;
  return (
    <div className={styles.zoomBar} role="toolbar" aria-label="缩放">
      <Tooltip content="缩小">
        <IconButton
          variant="ghost"
          size="regular"
          aria-label="缩小"
          {...limit(atMin)}
          onClick={atMin ? undefined : onZoomOut}
        >
          <ZoomOutIcon aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <span className={styles.value}>{value}</span>
      <Tooltip content="放大">
        <IconButton
          variant="ghost"
          size="regular"
          aria-label="放大"
          {...limit(atMax)}
          onClick={atMax ? undefined : onZoomIn}
        >
          <ZoomInIcon aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <span className={styles.divider} aria-hidden="true" />
      <Tooltip content="适应窗口">
        <IconButton
          variant="ghost"
          size="regular"
          aria-label="适应窗口"
          onClick={onFit}
        >
          <FitIcon aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Tooltip content="原始大小">
        <IconButton
          variant="ghost"
          size="regular"
          aria-label="原始大小 100%"
          onClick={onActualSize}
        >
          1:1
        </IconButton>
      </Tooltip>
    </div>
  );
}
