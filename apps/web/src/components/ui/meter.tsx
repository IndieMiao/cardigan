import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type MeterTone = "neutral" | "warning" | "danger";

/**
 * C-504: a value with a thin native meter underneath, as wide as the value
 * text. `label` names the meter with the reading.
 */
export function Meter({
  value,
  label,
  tone = "neutral",
  className,
  children,
}: {
  /** 0..100; out-of-range values are clamped. */
  readonly value: number;
  readonly label: string;
  readonly tone?: MeterTone;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      data-ui="meter"
      data-tone={tone}
      className={cn("ui-meter", className)}
    >
      {children}
      <meter
        className="ui-meter-track"
        min={0}
        max={100}
        value={Math.min(100, Math.max(0, value))}
        aria-label={label}
      />
    </span>
  );
}
