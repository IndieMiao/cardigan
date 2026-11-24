import type { ReactElement, ReactNode } from "react";
import * as DropdownMenu from "./ui/dropdown-menu.js";

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
    }
  | {
      /** A divider before a group, e.g. ahead of a destructive item. */
      readonly id: string;
      readonly kind: "separator";
    };

export interface MenuProps {
  readonly trigger: ReactElement;
  readonly items: readonly MenuItem[];
  readonly label?: string;
  readonly title?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly onCloseAutoFocus?: (event: Event) => void;
}

/** Dropdown menu with regular and persistent checkbox items. */
export function Menu({
  trigger,
  items,
  label = "菜单",
  title,
  footer,
  className,
  onCloseAutoFocus,
}: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={className ? `menu-content ${className}` : "menu-content"}
          onCloseAutoFocus={onCloseAutoFocus}
          sideOffset={6}
          aria-label={label}
        >
          {title && (
            <DropdownMenu.Label className="menu-title">
              {title}
            </DropdownMenu.Label>
          )}
          {items.map((item) =>
            item.kind === "separator" ? (
              <DropdownMenu.Separator key={item.id} />
            ) : item.kind === "checkbox" ? (
              <DropdownMenu.CheckboxItem
                key={item.id}
                className="menu-checkbox"
                checked={item.checked}
                disabled={item.disabled}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={item.onCheckedChange}
              >
                <span>{item.label}</span>
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
          {footer && <div className="menu-footer">{footer}</div>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
