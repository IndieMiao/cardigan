import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly delayDuration?: number;
}

/** Small text hint for icon buttons and metadata. */
export function Tooltip({
  content,
  children,
  side = "top",
  delayDuration = 200,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="tooltip-content"
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
