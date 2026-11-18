import type { ReactNode } from "react";
import { CapacitySummary } from "./Capacity.js";

/** Header summary without an extra box that would alter flex layout. */
export function PageSummary({
  actions,
  showCapacity = true,
  capacityByMachine = false,
}: {
  actions?: ReactNode;
  showCapacity?: boolean;
  capacityByMachine?: boolean;
}) {
  return (
    <>
      {actions && <div className="page-actions ui-page-actions">{actions}</div>}
      {showCapacity && <CapacitySummary byMachine={capacityByMachine} />}
    </>
  );
}
