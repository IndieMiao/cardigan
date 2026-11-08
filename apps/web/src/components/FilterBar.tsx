import { type ReactNode, useId } from "react";

export interface FilterField {
  key: string;
  label: string;
  options?: readonly { value: string; label: string }[];
}
/** Views own request semantics; this component supplies labels, controls and removable chips. */
export function FilterBar({
  fields,
  values,
  onChange,
  children,
}: {
  fields: readonly FilterField[];
  values: Readonly<Record<string, string>>;
  onChange: (values: Record<string, string>) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="filter-bar">
      <div className="filter-controls">
        {fields.map((field) => (
          <label key={field.key} htmlFor={`${id}-${field.key}`}>
            {field.label}
            {field.options ? (
              <select
                id={`${id}-${field.key}`}
                value={values[field.key] ?? ""}
                onChange={(e) =>
                  onChange({ ...values, [field.key]: e.target.value })
                }
              >
                <option value="">全部</option>
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${id}-${field.key}`}
                type="search"
                value={values[field.key] ?? ""}
                onChange={(e) =>
                  onChange({ ...values, [field.key]: e.target.value })
                }
              />
            )}
          </label>
        ))}
        {children}
      </div>
      {fields.some((f) => values[f.key]) && (
        <fieldset className="filter-chips">
          <legend className="visually-hidden">已选筛选</legend>
          {fields
            .filter((f) => values[f.key])
            .map((f) => (
              <button
                type="button"
                className="quiet"
                key={f.key}
                aria-label={`移除${f.label}筛选`}
                onClick={() => onChange({ ...values, [f.key]: "" })}
              >
                {f.label}：
                {f.options?.find((o) => o.value === values[f.key])?.label ??
                  values[f.key]}{" "}
                <span aria-hidden="true">×</span>
              </button>
            ))}
        </fieldset>
      )}
    </div>
  );
}
