import type { ReactNode } from "react";
import { PageSummary } from "../PageSummary.js";
export function PageHeader({
  title,
  count,
  actions,
  status,
  showCapacity = true,
  capacityByMachine = false,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  /** Compact borderless summary item placed before capacity on the right. */
  status?: ReactNode;
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
      <PageSummary
        actions={actions}
        status={status}
        showCapacity={showCapacity}
        capacityByMachine={capacityByMachine}
      />
    </header>
  );
}
