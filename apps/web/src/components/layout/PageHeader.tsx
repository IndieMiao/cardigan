import type { ReactNode } from "react";
import { CapacityStatus } from "../Capacity.js";
export function PageHeader({
  title,
  count,
  actions,
  showCapacity = true,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  showCapacity?: boolean;
}) {
  return (
    <header className="page-title ui-page-header">
      <div className="ui-page-heading">
        <h1>{title}</h1>
        {count !== undefined && <span className="cards-count">{count}</span>}
        {showCapacity && <CapacityStatus />}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
