import { type ReactNode, useId } from "react";
import { FilterBarLayout } from "./layout/FilterBar.js";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import { Input } from "./ui/input.js";
import { SelectControl } from "./ui/select-control.js";

export interface FilterField {
  key: string;
  label: string;
  options?: readonly { value: string; label: string }[];
  /** Render an option set as checkboxes; the route value is comma-separated. */
  multiple?: boolean;
  /** Custom control; receives the route value and its setter. */
  render?: (value: string, setValue: (value: string) => void) => ReactNode;
  /** Let this control take the row's remaining width (§9 U6a: the search box). */
  grow?: boolean;
  /** Some views provide their complete option set, including "all". */
  includeAllOption?: boolean;
  /** Value used when removing a chip; it is not itself an active filter. */
  clearValue?: string;
}

const valuesOf = (value: string | undefined): string[] =>
  (value ?? "").split(",").filter(Boolean);
/** Views own request semantics; this component supplies labels, controls and removable chips. */
export function FilterBar({
  fields,
  values,
  onChange,
  children,
  compact = false,
  summary,
}: {
  fields: readonly FilterField[];
  values: Readonly<Record<string, string>>;
  onChange: (values: Record<string, string>) => void;
  children?: ReactNode;
  compact?: boolean;
  summary?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`filter-bar${compact ? " filter-bar-compact" : ""}`}>
      <FilterBarLayout>
        {fields.map((field) =>
          field.render ? (
            <div
              key={field.key}
              className={`filter-custom${field.grow ? " filter-custom-grow" : ""}`}
            >
              {field.render(values[field.key] ?? "", (value) =>
                onChange({ ...values, [field.key]: value }),
              )}
            </div>
          ) : field.multiple && field.options ? (
            <fieldset
              key={field.key}
              className="filter-multi"
              aria-label={field.label}
            >
              <legend>{field.label}</legend>
              <div className="filter-multi-options">
                {field.options.map((option) => {
                  const selected = valuesOf(values[field.key]);
                  return (
                    <label key={option.value}>
                      <Checkbox
                        checked={selected.includes(option.value)}
                        onCheckedChange={() =>
                          onChange({
                            ...values,
                            [field.key]: (selected.includes(option.value)
                              ? selected.filter(
                                  (value) => value !== option.value,
                                )
                              : [...selected, option.value]
                            ).join(","),
                          })
                        }
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <label key={field.key} htmlFor={`${id}-${field.key}`}>
              <span className={compact ? "visually-hidden" : undefined}>
                {field.label}
              </span>
              {field.options ? (
                <SelectControl
                  id={`${id}-${field.key}`}
                  value={values[field.key] ?? ""}
                  onValueChange={(e) => onChange({ ...values, [field.key]: e })}
                >
                  {field.includeAllOption !== false && (
                    <option value="">全部</option>
                  )}
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </SelectControl>
              ) : (
                <Input
                  id={`${id}-${field.key}`}
                  type="search"
                  value={values[field.key] ?? ""}
                  onChange={(e) =>
                    onChange({ ...values, [field.key]: e.target.value })
                  }
                />
              )}
            </label>
          ),
        )}
        {children}
      </FilterBarLayout>
      {fields.some((f) => values[f.key] && values[f.key] !== f.clearValue) && (
        <fieldset className="filter-chips">
          <legend className="visually-hidden">已选筛选</legend>
          {fields
            .filter((f) => values[f.key] && values[f.key] !== f.clearValue)
            .map((f) => (
              <Button
                type="button"
                className="quiet"
                key={f.key}
                aria-label={`移除${f.label}筛选`}
                onClick={() =>
                  onChange({ ...values, [f.key]: f.clearValue ?? "" })
                }
              >
                {f.label}：
                {f.multiple
                  ? valuesOf(values[f.key])
                      .map(
                        (value) =>
                          f.options?.find((o) => o.value === value)?.label ??
                          value,
                      )
                      .join("、")
                  : (f.options?.find((o) => o.value === values[f.key])?.label ??
                    values[f.key])}{" "}
                <span aria-hidden="true">×</span>
              </Button>
            ))}
        </fieldset>
      )}
      {summary && <div className="filter-summary metadata">{summary}</div>}
    </div>
  );
}
