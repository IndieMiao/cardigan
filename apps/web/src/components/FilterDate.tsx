import { FilterDateLayout } from "./layout/FilterDateLayout.js";
import { Input } from "./ui/input.js";

/** Toolbar date filter: visible "标签：" prefix, value is the route's yyyy-mm-dd. */
export function FilterDate({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <FilterDateLayout>
      <span className="ui-select-prefix">{label}：</span>
      <Input
        type="date"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </FilterDateLayout>
  );
}
