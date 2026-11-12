import * as ToggleGroup from "@radix-ui/react-toggle-group";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";

export interface ViewSwitchOption {
  readonly value: string;
  readonly label: string;
  readonly icon: ReactNode;
}

export interface ViewSwitchProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly ViewSwitchOption[];
  readonly onChange: (value: string) => void;
  /** Show the text label beside the icon (U5a cards page). */
  readonly showLabel?: boolean;
}

/** Single-choice icon button group with aria-pressed toggle semantics. */
export function ViewSwitch({
  label,
  value,
  options,
  onChange,
  showLabel = false,
}: ViewSwitchProps) {
  return (
    <ToggleGroup.Root
      type="multiple"
      className="view-switch"
      value={[value]}
      onValueChange={(next) => {
        const last = next.at(-1);
        if (last !== undefined) onChange(last);
      }}
      aria-label={label}
    >
      {options.map((option) => (
        <Tooltip key={option.value} content={option.label}>
          <ToggleGroup.Item
            value={option.value}
            className="view-switch-item"
            aria-label={option.label}
          >
            {option.icon}
            {showLabel && <span>{option.label}</span>}
          </ToggleGroup.Item>
        </Tooltip>
      ))}
    </ToggleGroup.Root>
  );
}
