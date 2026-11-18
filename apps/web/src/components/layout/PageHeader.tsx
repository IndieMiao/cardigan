import type { ReactNode } from "react";
import { CapacityStatus } from "../Capacity.js";
export function PageHeader({
  title,
  count,
  actions,
  showCapacity = true,
  capacityByMachine = false,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  showCapacity?: boolean;
  capacityByMachine?: boolean;
}) {
  return (
    <header className="page-title ui-page-header">
      <div className="ui-page-heading">
        <h1>{title}</h1>
        {count !== undefined && (
          <span className="cards-count ui-page-count">{count}</span>
        )}
      </div>
      {actions && <div className="page-actions ui-page-actions">{actions}</div>}
      {showCapacity && <CapacityStatus byMachine={capacityByMachine} />}
    </header>
  );
}
