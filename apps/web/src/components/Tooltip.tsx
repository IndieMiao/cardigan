import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ReactElement, type ReactNode, useRef, useState } from "react";

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly className?: string;
  /** Opt in only when the hint text itself must be selectable for copying. */
  readonly selectable?: boolean;
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
  clearAbove,
}: TooltipProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [sideOffset, setSideOffset] = useState(6);
  if (content === undefined || content === null || content === "")
    return children;
  return (
    <TooltipPrimitive.Provider delayDuration={1000} skipDelayDuration={0}>
      <TooltipPrimitive.Root
        onOpenChange={(open) => {
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
        <TooltipPrimitive.Trigger ref={trigger} asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={`tooltip-content ${className}`}
            data-passive={selectable ? undefined : ""}
            // Override Radix's pointer-events: auto inside modal layers too.
            style={{ pointerEvents: selectable ? undefined : "none" }}
            side={side}
            sideOffset={sideOffset}
          >
            {content}
            <TooltipPrimitive.Arrow className="tooltip-arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
