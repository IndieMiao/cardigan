import { Button, ButtonLabel, type ButtonProps } from "./button.js";

/** A removable filter value with bounded text and its full value on hover. */
export function FilterChip({
  label,
  ...props
}: Omit<ButtonProps, "children" | "className" | "title" | "asChild"> & {
  label: string;
}) {
  return (
    <Button {...props} className="ui-filter-chip" title={label}>
      <ButtonLabel>{label}</ButtonLabel>
      <span className="ui-filter-chip-remove" aria-hidden="true">
        ×
      </span>
    </Button>
  );
}
