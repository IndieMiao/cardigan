import { SelectControl } from "./ui/select-control.js";

/** The cards page's single-choice filter. Form selects use SelectControl. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <SelectControl
      aria-label={`${label}：${options.find((option) => option.value === value)?.label ?? "全部"}`}
      prefix={label}
      value={value}
      onValueChange={onChange}
    >
      <option value="">全部</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SelectControl>
  );
}
