import { SelectControl } from "./ui/select-control.js";

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Keep an active route value visible in its own control even when it is no
 * longer a known option (for example a retired machine in an old link), so the
 * control, route and filtered list describe the same state and "全部" clears it.
 */
export function withActiveOptions(
  options: readonly FilterOption[],
  active: readonly string[],
): readonly FilterOption[] {
  const missing = active.filter(
    (value) => value && !options.some((option) => option.value === value),
  );
  return missing.length
    ? [...options, ...missing.map((value) => ({ value, label: value }))]
    : options;
}

/** The cards page's single-choice filter. Form selects use SelectControl. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly FilterOption[];
  readonly onChange: (value: string) => void;
}) {
  const shown = withActiveOptions(options, [value]);
  return (
    <SelectControl
      aria-label={`${label}：${shown.find((option) => option.value === value)?.label ?? "全部"}`}
      prefix={label}
      value={value}
      onValueChange={onChange}
    >
      <option value="">全部</option>
      {shown.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SelectControl>
  );
}
