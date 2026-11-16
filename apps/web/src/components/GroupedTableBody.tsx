import { Fragment, type ReactNode, useId, useState } from "react";
import { groupRows, type RowGroup } from "../group-rows.js";

/** Field grouping for existing tables; does not fetch, filter or sort rows. */
export function GroupedTableBody<T>({
  rows,
  groupBy,
  groupName = (group) => group.id,
  renderRow,
  columns,
  renderLabel,
  countLabel = "项",
  headingClassName = "",
  collapsed: controlledCollapsed,
  onToggle,
}: {
  readonly rows: readonly T[];
  readonly groupBy?: ((row: T) => string) | undefined;
  readonly groupName?: (group: RowGroup<T>) => string;
  readonly renderRow: (row: T) => ReactNode;
  readonly columns: number;
  readonly renderLabel?: (group: RowGroup<T>) => ReactNode;
  readonly countLabel?: string;
  readonly headingClassName?: string;
  readonly collapsed?: ReadonlySet<string>;
  readonly onToggle?: (id: string) => void;
}) {
  const id = useId();
  const [localCollapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const collapsed = controlledCollapsed ?? localCollapsed;
  const toggle = (key: string) => {
    if (onToggle) return onToggle(key);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  if (!groupBy) return <tbody>{rows.map(renderRow)}</tbody>;
  return groupRows(rows, groupBy).map((group, index) => {
    const name = groupName(group);
    const folded = collapsed.has(group.id);
    const bodyId = `${id}-${index}`;
    return (
      <Fragment key={group.id}>
        <tbody>
          <tr>
            <td colSpan={columns}>
              <div className={`table-group-heading ${headingClassName}`}>
                {renderLabel ? (
                  renderLabel(group)
                ) : (
                  <span className="table-group-label">
                    {name}
                    <span className="hint">
                      {group.rows.length} {countLabel}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  className="quiet"
                  aria-label={`${folded ? "展开" : "折叠"}${name}分组`}
                  aria-expanded={!folded}
                  aria-controls={bodyId}
                  onClick={() => toggle(group.id)}
                >
                  {folded ? "展开" : "折叠"}
                  <span aria-hidden="true">{folded ? " ▸" : " ▾"}</span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
        <tbody id={bodyId} aria-label={name} hidden={folded}>
          {group.rows.map(renderRow)}
        </tbody>
      </Fragment>
    );
  });
}
