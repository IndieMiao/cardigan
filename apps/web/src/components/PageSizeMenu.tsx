import { Menu } from "./Menu.js";

/** Shared count selector for timeline loading and card list pagination. */
export function PageSizeMenu({
  label,
  pageSize,
  sizes,
  unit = "条",
  compact = false,
  onChange,
}: {
  readonly label: string;
  readonly pageSize: number;
  readonly sizes: readonly number[];
  readonly unit?: string;
  readonly compact?: boolean;
  readonly onChange: (size: number) => void;
}) {
  return (
    <Menu
      label={label}
      trigger={
        <button
          type="button"
          className="quiet timeline-load"
          aria-label={`${label}：${pageSize} ${unit}`}
        >
          {!compact && `${label}：${pageSize} ${unit} `}
          <span aria-hidden="true">▾</span>
        </button>
      }
      items={sizes.map((size) => ({
        id: String(size),
        label: `${size} ${unit}${pageSize === size ? "（当前）" : ""}`,
        onSelect: () => onChange(size),
      }))}
    />
  );
}
