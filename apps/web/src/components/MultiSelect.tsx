import { useRef, useState } from "react";
import { Button, ButtonLabel } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import { ChevronDownIcon } from "./ui/icons.js";
import * as Popover from "./ui/popover.js";

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

/** A filter-style multi-select dropdown; its leading empty-label row clears the selection. */
export function MultiSelect({
  label,
  options,
  values,
  onChange,
  emptyLabel = "全部",
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.filter((option) => values.includes(option.value));
  const text =
    selected.length === 0
      ? emptyLabel
      : selected.map((option) => option.label).join("、");
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) trigger.current?.focus();
      }}
    >
      <Popover.Trigger asChild>
        <Button
          ref={trigger}
          type="button"
          className="multiselect-trigger"
          aria-label={`${label}：${text}`}
          title={`${label}：${text}`}
        >
          <ButtonLabel>
            {label}：{text}
          </ButtonLabel>
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover-content multiselect-content"
          align="start"
          sideOffset={6}
          aria-label={label}
        >
          <label className="multiselect-option ui-checkbox-row">
            <Checkbox
              checked={values.length === 0}
              onCheckedChange={() => {
                if (values.length > 0) onChange([]);
              }}
            />
            {emptyLabel}
          </label>
          {options.map((option) => {
            const checked = values.includes(option.value);
            return (
              <label
                key={option.value}
                className="multiselect-option ui-checkbox-row"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() =>
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
