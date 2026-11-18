import type { ReactElement } from "react";
import { Tooltip } from "./Tooltip.js";

export function DetailsTip({
  lines,
  children,
}: {
  lines: readonly string[];
  children: ReactElement;
}) {
  return (
    <Tooltip
      side="bottom"
      scrollable
      content={
        <div className="ui-tooltip-details">
          {[...new Set(lines.filter(Boolean))].map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      }
    >
      {children}
    </Tooltip>
  );
}
