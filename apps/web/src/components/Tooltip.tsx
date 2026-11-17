import { type ReactElement, type ReactNode, useRef, useState } from "react";
import * as TooltipPrimitive from "./ui/tooltip.js";

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly className?: string;
  /** Opt in only when the hint text itself must be selectable for copying. */
  readonly selectable?: boolean;
  /** Keep long details within the viewport; scroll with the pointer or trigger's keys. */
  readonly scrollable?: boolean;
  /** Place a top hint above this closest ancestor, keeping its header visible. */
  readonly clearAbove?: string | undefined;
}

/** Small text hint for icon buttons and metadata. */
export function Tooltip({
  content,
  children,
  side = "top",
  className = "",
  selectable = false,
  scrollable = false,
  clearAbove,
}: TooltipProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const scrollArea = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [sideOffset, setSideOffset] = useState(6);
  if (content === undefined || content === null || content === "")
    return children;
  return (
    <TooltipPrimitive.Provider delayDuration={1000} skipDelayDuration={0}>
      <TooltipPrimitive.Root
        open={scrollable ? open : undefined}
        onOpenChange={(open) => {
          // Keep keyboard details open during pointer transit or focus scrolling.
          if (
            !open &&
            scrollable &&
            (scrollArea.current === document.activeElement ||
              trigger.current === document.activeElement)
          )
            return;
          if (scrollable) setOpen(open);
          if (!open) return;
          const anchor = trigger.current;
          const boundary = clearAbove && anchor?.closest(clearAbove);
          setSideOffset(
            6 +
              (side === "top" && anchor && boundary
                ? Math.max(
                    0,
                    anchor.getBoundingClientRect().top -
                      boundary.getBoundingClientRect().top,
                  )
                : 0),
          );
        }}
      >
        <TooltipPrimitive.Trigger
          ref={trigger}
          asChild
          onClick={scrollable ? () => setOpen(false) : undefined}
          onBlur={(event) => {
            if (scrollArea.current?.contains(event.relatedTarget))
              event.preventDefault();
          }}
          onKeyDown={(event) => {
            const area = scrollArea.current;
            if (
              !area ||
              event.defaultPrevented ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              area.scrollHeight <= area.clientHeight
            )
              return;
            if (event.key === "Tab" && !event.shiftKey) {
              area.focus();
              event.preventDefault();
              return;
            }
            const style = getComputedStyle(area);
            const line =
              Number.parseFloat(style.lineHeight) ||
              Number.parseFloat(style.fontSize);
            const page = Math.max(line, area.clientHeight - line);
            let top = area.scrollTop;
            switch (event.key) {
              case "ArrowDown":
                top += line;
                break;
              case "ArrowUp":
                top -= line;
                break;
              case "PageDown":
                top += page;
                break;
              case "PageUp":
                top -= page;
                break;
              case "Home":
                top = 0;
                break;
              case "End":
                top = area.scrollHeight;
                break;
              default:
                return;
            }
            area.scrollTop = Math.max(
              0,
              Math.min(top, area.scrollHeight - area.clientHeight),
            );
            event.preventDefault();
          }}
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={`tooltip-content ${className}`}
            data-passive={selectable || scrollable ? undefined : ""}
            // Override Radix's pointer-events: auto inside modal layers too.
            style={{
              pointerEvents: selectable || scrollable ? undefined : "none",
            }}
            side={side}
            sideOffset={sideOffset}
            onEscapeKeyDown={
              scrollable
                ? () => {
                    if (scrollArea.current === document.activeElement)
                      trigger.current?.focus();
                    setOpen(false);
                  }
                : undefined
            }
            onPointerDownOutside={scrollable ? () => setOpen(false) : undefined}
          >
            {scrollable ? (
              <section
                ref={scrollArea}
                className="ui-tooltip-scrollarea"
                aria-label="提示详情"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable text needs a keyboard focus target.
                tabIndex={0}
                onBlur={(event) => {
                  if (event.relatedTarget !== trigger.current) setOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Tab") return;
                  // Resume the trigger's tab order instead of the portal's.
                  trigger.current?.focus();
                  if (event.shiftKey) event.preventDefault();
                  else setOpen(false);
                }}
              >
                {content}
              </section>
            ) : (
              content
            )}
            <TooltipPrimitive.Arrow className="tooltip-arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
