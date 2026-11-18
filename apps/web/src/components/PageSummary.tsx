import type { ReactNode } from "react";
import { CapacitySummary } from "./Capacity.js";

/** Header summary without an extra box that would alter flex layout. */
export function PageSummary({
  actions,
  status,
  showCapacity = true,
  capacityByMachine = false,
}: {
  actions?: ReactNode;
  status?: ReactNode;
  showCapacity?: boolean;
  capacityByMachine?: boolean;
}) {
  return (
    <>
      {actions && <div className="page-actions ui-page-actions">{actions}</div>}
      {status && <div className="ui-page-status">{status}</div>}
      {showCapacity && <CapacitySummary byMachine={capacityByMachine} />}
    </>
  );
}
