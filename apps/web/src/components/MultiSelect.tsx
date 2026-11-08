import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface MultiSelectProps {
  readonly label: string;
  readonly options: readonly MultiSelectOption[];
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly emptyLabel?: string;
}

/** A filter-style multi-select dropdown sharing the existing form styling. */
export function MultiSelect({
  label,
  options,
  values,
  onChange,
  emptyLabel = "全部",
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (trigger.current?.contains(target) || content.current?.contains(target))
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutside, true);
  }, [open]);
  const selected = options.filter((option) => values.includes(option.value));
  const text =
    selected.length === 0
      ? emptyLabel
      : selected.map((option) => option.label).join("、");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="multiselect-trigger"
          aria-label={`${label}：${text}`}
        >
          <span>
            {label}：{text}
          </span>
          <span aria-hidden="true">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="popover-content multiselect-content"
          align="start"
          sideOffset={6}
          aria-label={label}
        >
          {options.map((option) => {
            const checked = values.includes(option.value);
            return (
              <label key={option.value} className="multiselect-option">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(
                      checked
                        ? values.filter((value) => value !== option.value)
                        : [...values, option.value],
                    )
                  }
                />
                {option.label}
              </label>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
