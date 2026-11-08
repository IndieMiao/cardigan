import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";

export type MenuItem =
  | {
      readonly id: string;
      readonly label: ReactNode;
      readonly kind?: "item";
      readonly onSelect?: () => void;
      readonly disabled?: boolean;
    }
  | {
      readonly id: string;
      readonly label: ReactNode;
      readonly kind: "checkbox";
      readonly checked: boolean;
      readonly onCheckedChange: (checked: boolean) => void;
      readonly disabled?: boolean;
    };

export interface MenuProps {
  readonly trigger: ReactElement;
  readonly items: readonly MenuItem[];
  readonly label?: string;
}

/** Dropdown menu with regular and persistent checkbox items. */
export function Menu({ trigger, items, label = "菜单" }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-content"
          sideOffset={6}
          aria-label={label}
        >
          {items.map((item) =>
            item.kind === "checkbox" ? (
              <DropdownMenu.CheckboxItem
                key={item.id}
                className="menu-checkbox"
                checked={item.checked}
                disabled={item.disabled}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={item.onCheckedChange}
              >
                <span>{item.label}</span>
                <DropdownMenu.ItemIndicator className="menu-indicator">
                  ✓
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
            ) : (
              <DropdownMenu.Item
                key={item.id}
                className="menu-item"
                disabled={item.disabled}
                onSelect={item.onSelect}
              >
                {item.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
