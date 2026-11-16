export interface RowGroup<T> {
  readonly id: string;
  readonly rows: T[];
}

/** Preserve the current row order and each group's first occurrence. */
export function groupRows<T>(
  rows: readonly T[],
  key: (row: T) => string,
): RowGroup<T>[] {
  const groups = new Map<string, RowGroup<T>>();
  for (const row of rows) {
    const id = key(row);
    let group = groups.get(id);
    if (!group) {
      group = { id, rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}
