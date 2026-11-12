import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly className?: string;
}

/** Small text hint for icon buttons and metadata. */
export function Tooltip({
  content,
  children,
  side = "top",
  className = "",
}: TooltipProps) {
  if (content === undefined || content === null || content === "")
    return children;
  return (
    <TooltipPrimitive.Provider delayDuration={1000} skipDelayDuration={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={`tooltip-content ${className}`}
            side={side}
            sideOffset={6}
          >
            {content}
            <TooltipPrimitive.Arrow className="tooltip-arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
